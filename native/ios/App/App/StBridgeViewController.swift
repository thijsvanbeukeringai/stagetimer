import Capacitor
import UIKit

// The app's own bridge view controller. Capacitor 8 only registers plugins
// that come from Swift packages (packageClassList in the generated
// capacitor.config.json); plugins living in this target are registered here,
// before the web view loads, so their JS proxy exists at document start.
class StBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(StLiveActivityPlugin())
    }

    #if DEBUG
    private var demoDone = false
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // ActivityKit only starts an activity while the app is in the foreground.
        if !demoDone { demoDone = true; StLiveActivityPlugin.startDemoIfRequested() }
    }
    #endif
}
