import UIKit
import WebKit
import Capacitor

/// The app's one screen: Capacitor's web view plus the plugins only Romulus has (the iPhone side of
/// MainActivity.java). Widget taps arrive as romulus://hook?kind=…&arg=… links and become a call to
/// window.__tasksHook in the page, the same as Android's widget intents.
class RomulusViewController: CAPBridgeViewController {
    static weak var shared: RomulusViewController?

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)
        // which build this is (Android gets it from store.js per build flavor): the App Store build shows no
        // update banner (update-phone.js) and no Stripe button (hosted-sync.js)
        config.userContentController.addUserScript(WKUserScript(
            source: "window.ROMULUS_STORE='appstore';",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        return config
    }

    override func capacitorDidLoad() {
        RomulusViewController.shared = self
        bridge?.registerPluginInstance(HealthPlugin())       // Apple Health: daily steps, exercise and sleep for tasks that tick themselves off
        bridge?.registerPluginInstance(VoicePlugin())        // talk to add a task
        bridge?.registerPluginInstance(ShareLinkPlugin())    // send an option's link to people
        bridge?.registerPluginInstance(WakeWordPlugin())     // "Hey Romulus", while the app is open
        bridge?.registerPluginInstance(CalAccountsPlugin())  // Google / Microsoft calendar sign-in, calendar links
        bridge?.registerPluginInstance(FinanceVaultPlugin()) // Finance: Face ID lock, pairing scan, bank/price requests
        bridge?.registerPluginInstance(WidgetDataPlugin())   // what the home-screen widgets show
        NotificationCenter.default.addObserver(self, selector: #selector(openURL(_:)), name: .capacitorOpenURL, object: nil)
    }

    @objc private func openURL(_ note: Notification) {
        guard let info = note.object as? [String: Any], let url = info["url"] as? URL,
              url.scheme == "romulus", url.host == "hook",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return }
        let kind = items.first(where: { $0.name == "kind" })?.value ?? ""
        // only what a widget can ask for; anything else in a link is ignored
        guard ["open", "tab", "voice", "quickAdd"].contains(kind) else { return }
        var hook: [String: String] = ["kind": kind]
        if let arg = items.first(where: { $0.name == "arg" })?.value, arg.count <= 200 { hook["arg"] = arg }
        sendHook(hook)
    }

    /// window.__tasksHook(p) once the page has it (it loads asynchronously: retried for up to ~15 s).
    func sendHook(_ hook: [String: String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: hook),
              let json = String(data: data, encoding: .utf8) else { return }
        deliver(json, attempt: 0)
    }

    private func deliver(_ json: String, attempt: Int) {
        guard attempt <= 60 else { return }
        let retry = { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.deliver(json, attempt: attempt + 1) } }
        guard let webView = webView else { retry(); return }
        webView.evaluateJavaScript("typeof window.__tasksHook==='function'") { ready, _ in
            guard (ready as? Bool) == true else { retry(); return }
            webView.evaluateJavaScript("window.__tasksHook(\(json))", completionHandler: nil)
        }
    }
}
