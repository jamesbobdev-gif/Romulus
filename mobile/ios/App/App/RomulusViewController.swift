import UIKit
import Capacitor

/// The app's web view (Main.storyboard names this class), with the iPhone's own plugins registered on top of
/// Capacitor's. The Android side does the same in MainActivity.java.
class RomulusViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HealthPlugin()) // Apple Health: daily steps, exercise and sleep for tasks that tick themselves off
    }
}
