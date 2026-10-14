#!/usr/bin/env ruby
# Adds the Live Activity widget extension (BOUWPLAN phase 6, step 4) to the
# Capacitor-generated ios/App/App.xcodeproj, and the app-side Swift files
# (plugin, bridge view controller, shared attributes) to the App target.
#
# The Capacitor project stays the source of truth: this script only adds to
# it, and it is safe to run again (after a `cap add ios` from scratch, or to
# repair settings). Each run converges on the same result.
#
#   cd native && ruby scripts/add-live-activity-target.rb
#
# Needs the xcodeproj gem (comes with CocoaPods; `gem install xcodeproj`).
require 'xcodeproj'

ROOT = File.expand_path('../ios/App', __dir__)
PROJECT = File.join(ROOT, 'App.xcodeproj')
EXT = 'StagetimerLiveActivity'
TEAM = 'CM737LH9GZ'
DEPLOYMENT = '16.4'
EXT_BUNDLE_ID = 'nl.stagetimer.booth.LiveActivity'

project = Xcodeproj::Project.open(PROJECT)
app = project.targets.find { |t| t.name == 'App' } or abort('App target not found')

# Group for a folder next to App/ (path relative to the project dir).
def group_for(project, name)
  project.main_group.children.find { |g| g.isa == 'PBXGroup' && g.path == name } ||
    project.main_group.new_group(name, name)
end

def file_in(group, name)
  group.files.find { |f| f.path == name } || group.new_reference(name)
end

def add_source(target, ref)
  target.source_build_phase.add_file_reference(ref, true) # true = no duplicates
end

# ── Versions live on the project, so the app and the extension can never
# drift apart (App Store Connect rejects an extension whose CFBundleVersion /
# CFBundleShortVersionString differ from the app's). Bump them there.
versions = {}
app.build_configurations.each do |c|
  %w[MARKETING_VERSION CURRENT_PROJECT_VERSION].each do |k|
    versions[k] ||= c.build_settings[k]
    c.build_settings.delete(k)
  end
end
project.build_configurations.each do |c|
  c.build_settings['MARKETING_VERSION'] ||= versions['MARKETING_VERSION'] || '1.0'
  c.build_settings['CURRENT_PROJECT_VERSION'] ||= versions['CURRENT_PROJECT_VERSION'] || '1'
end

# ── App target: the plugin, its bridge view controller, the shared type.
app_group = project.main_group.children.find { |g| g.isa == 'PBXGroup' && g.path == 'App' } or abort('App group not found')
shared = group_for(project, 'Shared')
attributes_ref = file_in(shared, 'StShowAttributes.swift')
%w[StLiveActivityPlugin.swift StBridgeViewController.swift].each { |f| add_source(app, file_in(app_group, f)) }
add_source(app, attributes_ref)

# ── Extension target.
ext = project.targets.find { |t| t.name == EXT }
unless ext
  ext = project.new_target(:app_extension, EXT, :ios, DEPLOYMENT, nil, :swift)
  # new_target links Foundation.framework from the iOS SDK; Swift links what it imports.
  # Drop it, with the Frameworks group it creates (pinned to an old SDK path).
  ext.frameworks_build_phase.files.dup.each { |bf| bf.remove_from_project }
end
fw = project.main_group.children.find { |g| g.isa == 'PBXGroup' && g.name == 'Frameworks' && g.path.nil? }
if fw && fw.recursive_children.select { |c| c.isa == 'PBXFileReference' }.all? { |r| r.path.to_s.end_with?('Foundation.framework') && r.build_files.empty? }
  fw.recursive_children.select { |c| c.isa == 'PBXFileReference' }.each(&:remove_from_project)
  fw.recursive_children.each(&:remove_from_project)
  fw.remove_from_project
end
ext_group = group_for(project, EXT)
file_in(ext_group, 'Info.plist')
add_source(ext, file_in(ext_group, 'StagetimerLiveActivity.swift'))
add_source(ext, attributes_ref)

ext.build_configurations.each do |c|
  s = c.build_settings
  s['PRODUCT_NAME'] = '$(TARGET_NAME)'
  s['PRODUCT_BUNDLE_IDENTIFIER'] = EXT_BUNDLE_ID
  s['INFOPLIST_FILE'] = "#{EXT}/Info.plist"
  s['GENERATE_INFOPLIST_FILE'] = 'NO'
  s['DEVELOPMENT_TEAM'] = TEAM
  s['CODE_SIGN_STYLE'] = 'Automatic'
  s['IPHONEOS_DEPLOYMENT_TARGET'] = DEPLOYMENT
  s['TARGETED_DEVICE_FAMILY'] = '1,2'
  s['SWIFT_VERSION'] = '5.0'
  s['SKIP_INSTALL'] = 'YES'
  s['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  s['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = c.name == 'Debug' ? 'DEBUG' : ''
  s.delete('MARKETING_VERSION')
  s.delete('CURRENT_PROJECT_VERSION')
end
attrs = project.root_object.attributes['TargetAttributes'] ||= {}
attrs[ext.uuid] = (attrs[ext.uuid] || {}).merge('DevelopmentTeam' => TEAM, 'ProvisioningStyle' => 'Automatic')

# ── Embed the extension in the app (PlugIns/) and build it first.
embed = app.copy_files_build_phases.find { |p| p.name == 'Embed Foundation Extensions' } ||
        app.new_copy_files_build_phase('Embed Foundation Extensions')
embed.symbol_dst_subfolder_spec = :plug_ins
embed.dst_path = ''
unless embed.files_references.include?(ext.product_reference)
  bf = embed.add_file_reference(ext.product_reference)
  bf.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end
app.add_dependency(ext) unless app.dependencies.any? { |d| d.target == ext }

project.save
puts "OK: #{EXT} (#{EXT_BUNDLE_ID}) embedded in App; plugin + shared attributes in App."
