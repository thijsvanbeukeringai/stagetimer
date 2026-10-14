import ActivityKit
import Capacitor
import Foundation

// Local Capacitor plugin (JS: Capacitor.Plugins.StLiveActivity), registered
// by StBridgeViewController. The web app drives it from its LIVE ACTIVITY
// block: one activity at a time for this device's selected stage.
//   isAvailable()            -> {available}
//   start({stageName, showName, nextName, startsAt, endsAt, phase,
//          overrun, manual, pausedAt})   replaces any running activity
//   update({...same})        rejects NO_ACTIVITY when there is none
//   end()                    dismisses immediately
// Times are ms since the epoch on the DEVICE clock. Every ActivityKit error
// comes back as a rejected call: a lock-screen extra must never take the
// operator's control screen down with it.
@objc(StLiveActivityPlugin)
public class StLiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StLiveActivityPlugin"
    public let jsName = "StLiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise)
    ]

    private static let phases: Set<String> = ["live", "upcoming", "paused", "ready"]
    // ActivityKit caps the whole payload at 4 KB; names never need this much.
    private static let maxName = 80

    override public func load() {
        // An activity left by an earlier run (app killed, logged out, crashed)
        // would keep counting down a show nobody follows any more. The web app
        // starts a fresh one within a second when it should be there.
        let leftovers = Activity<StShowAttributes>.activities
        if leftovers.isEmpty { return }
        Task { for activity in leftovers { await activity.end(nil, dismissalPolicy: .immediate) } }
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        // False where Live Activities are unsupported (iPad) or switched off by the user.
        call.resolve(["available": ActivityAuthorizationInfo().areActivitiesEnabled])
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let args = parse(call) else { return }
        Task { @MainActor in
            do {
                try await Self.startActivity(stageName: args.stageName, state: args.state)
                call.resolve()
            } catch {
                call.reject("Live Activity could not start: \(error.localizedDescription)", "START_FAILED", error)
            }
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard let args = parse(call) else { return }
        Task { @MainActor in
            if await Self.updateActivity(state: args.state) {
                call.resolve()
            } else {
                // Ended by the system or swiped away by the user: the caller
                // decides whether to start a new one.
                call.reject("No running Live Activity", "NO_ACTIVITY")
            }
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        Task { @MainActor in
            await Self.endAll()
            call.resolve()
        }
    }

    // MARK: - ActivityKit

    @MainActor
    static func startActivity(stageName: String, state: StShowAttributes.ContentState) async throws {
        let old = Activity<StShowAttributes>.activities
        var failure: Error?
        do {
            let content = ActivityContent(state: state, staleDate: staleDate(for: state))
            _ = try Activity.request(attributes: StShowAttributes(stageName: stageName), content: content, pushType: nil)
        } catch {
            failure = error
        }
        // Old ones go also when the new one failed: a countdown for the
        // previous stage or show is worse than none.
        for activity in old { await activity.end(nil, dismissalPolicy: .immediate) }
        if let failure { throw failure }
    }

    @MainActor
    static func updateActivity(state: StShowAttributes.ContentState) async -> Bool {
        guard let activity = Activity<StShowAttributes>.activities.last(where: { $0.activityState == .active }) else {
            return false
        }
        await activity.update(ActivityContent(state: state, staleDate: staleDate(for: state)))
        return true
    }

    @MainActor
    static func endAll() async {
        for activity in Activity<StShowAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    // At the stale date iOS redraws the activity with context.isStale set,
    // without the app: a scheduled show then reads "Ended", a manual timer
    // turns into red overtime, an upcoming show "Starting". Needed because
    // the web view is suspended while the phone is locked.
    static func staleDate(for state: StShowAttributes.ContentState) -> Date? {
        switch state.phase {
        case "live": return state.overrun ? nil : state.endsAt
        case "upcoming": return state.startsAt
        default: return nil
        }
    }

    // MARK: - Arguments

    private struct Args {
        let stageName: String
        let state: StShowAttributes.ContentState
    }

    private static func clean(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(maxName))
    }

    private static func date(_ ms: Double?) -> Date? {
        guard let ms, ms.isFinite, ms > 0 else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }

    private func parse(_ call: CAPPluginCall) -> Args? {
        guard let startsAt = Self.date(call.getDouble("startsAt")), let endsAt = Self.date(call.getDouble("endsAt")) else {
            call.reject("startsAt and endsAt (ms since epoch) are required", "BAD_ARGS")
            return nil
        }
        // The views build startsAt...endsAt ranges; a reversed range traps.
        guard endsAt > startsAt else {
            call.reject("endsAt must be after startsAt", "BAD_ARGS")
            return nil
        }
        let phase = call.getString("phase") ?? "live"
        guard Self.phases.contains(phase) else {
            call.reject("Unknown phase \(phase)", "BAD_ARGS")
            return nil
        }
        let pausedAt = Self.date(call.getDouble("pausedAt"))
        if (phase == "paused" || phase == "ready") && pausedAt == nil {
            call.reject("pausedAt is required for phase \(phase)", "BAD_ARGS")
            return nil
        }
        let state = StShowAttributes.ContentState(
            showName: Self.clean(call.getString("showName")) ?? "-",
            nextName: Self.clean(call.getString("nextName")),
            startsAt: startsAt,
            endsAt: endsAt,
            phase: phase,
            overrun: call.getBool("overrun") ?? false,
            manual: call.getBool("manual") ?? false,
            pausedAt: pausedAt
        )
        return Args(stageName: Self.clean(call.getString("stageName")) ?? "Stage", state: state)
    }
}

#if DEBUG
// Simulator check without a backend (nothing can log in there yet):
//   xcrun simctl launch booted nl.stagetimer.booth -STLiveActivityDemo live
// with live | overrun | upcoming | paused. Debug builds only.
extension StLiveActivityPlugin {
    @MainActor
    static func startDemoIfRequested() {
        guard let kind = UserDefaults.standard.string(forKey: "STLiveActivityDemo") else { return }
        let now = Date()
        var state = StShowAttributes.ContentState(
            showName: "Demo Artist", nextName: "Next Artist",
            startsAt: now.addingTimeInterval(-25 * 60), endsAt: now.addingTimeInterval(20 * 60 + 12),
            phase: "live", overrun: false, manual: false, pausedAt: nil)
        switch kind {
        case "overrun":
            state.manual = true; state.overrun = true
            state.startsAt = now.addingTimeInterval(-62 * 60); state.endsAt = now.addingTimeInterval(-2 * 60 - 5)
        case "upcoming":
            state.phase = "upcoming"
            state.startsAt = now.addingTimeInterval(14 * 60 + 30); state.endsAt = now.addingTimeInterval(74 * 60 + 30)
        case "paused":
            state.phase = "paused"; state.manual = true; state.pausedAt = now
        default: break
        }
        Task {
            do { try await startActivity(stageName: "Main Stage", state: state) } catch { print("[liveactivity] demo failed:", error) }
        }
    }
}
#endif
