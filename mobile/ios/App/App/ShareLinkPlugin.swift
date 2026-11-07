import UIKit
import Capacitor

/// The iPhone's Share sheet with just a link in it (ShareLinkPlugin.java on Android), so he can send it to
/// people in Messages, WhatsApp and so on. He picks who and sends it himself; nothing goes out on its own.
@objc(ShareLinkPlugin)
public class ShareLinkPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareLinkPlugin"
    public let jsName = "ShareLink"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise)
    ]

    @objc func share(_ call: CAPPluginCall) {
        let text = call.getString("url", "")
        guard text.range(of: "^https?://.+", options: [.regularExpression, .caseInsensitive]) != nil, let url = URL(string: text) else {
            call.reject("Not a link")
            return
        }
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else { call.reject("Open the app first."); return }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let pop = sheet.popoverPresentationController { // iPad: the sheet needs somewhere to point
                pop.sourceView = vc.view
                pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 1, height: 1)
                pop.permittedArrowDirections = []
            }
            vc.present(sheet, animated: true)
            call.resolve()
        }
    }
}
