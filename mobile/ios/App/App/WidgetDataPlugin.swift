import Foundation
import WidgetKit
import Capacitor

/// The page hands the widgets their rows (mobile/widgets-phone.js), and takes back the tasks he checked off
/// on a widget so it can save them like any other check-off.
@objc(WidgetDataPlugin)
public class WidgetDataPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WidgetDataPlugin"
    public let jsName = "WidgetData"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takePending", returnType: CAPPluginReturnPromise)
    ]

    /// {data: JSON text of a WidgetSnapshot}
    @objc func set(_ call: CAPPluginCall) {
        guard let text = call.getString("data"), text.utf8.count < 512 * 1024,
              let data = text.data(using: .utf8),
              (try? JSONDecoder().decode(WidgetSnapshot.self, from: data)) != nil else {
            call.reject("not a widget snapshot")
            return
        }
        WidgetShared.saveSnapshot(data)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    /// → {ids}: checked off on a widget since the last time; the page marks them done and saves.
    @objc func takePending(_ call: CAPPluginCall) {
        call.resolve(["ids": WidgetShared.takePending()])
    }
}
