import UIKit
import Capacitor

/// The app's web view (Main.storyboard names this class), with the iPhone's own plugins registered on top of
/// Capacitor's. The Android side does the same in MainActivity.java.
class RomulusViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HealthDataPlugin()) // Apple Health: steps, sleep and workouts for goal to-dos
    }
}
