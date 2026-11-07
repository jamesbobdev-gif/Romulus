import Foundation
import UIKit
import AVFoundation
import LocalAuthentication
import Security
import Capacitor

/// Finance on the iPhone (mobile/finance-phone.js; FinanceVaultPlugin.java on Android). The bank data is
/// encrypted in the page with a random key; that key is kept in the Keychain behind Face ID or Touch ID
/// (.biometryCurrentSet), so opening Finance always takes his face or finger, and enrolling a new face or
/// finger makes the key unreadable: then Finance has to be paired again.
/// Also: scanning the pairing QR code from the computer, and web requests to SimpleFIN and Yahoo Finance
/// only (the page can't reach them itself).
@objc(FinanceVaultPlugin)
public class FinanceVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FinanceVaultPlugin"
    public let jsName = "FinanceVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isSetUp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "http", returnType: CAPPluginReturnPromise)
    ]

    private let service = "com.jartro.tasks.finance"
    private let account = "datakey"
    private let setUpKey = "finance.setUp"
    private let io = DispatchQueue(label: "finance.vault")
    private var cover: UIView?
    private var secureOn = false

    private var file: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("finance.vault")
    }

    override public func load() {
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(hideForSwitcher), name: UIApplication.willResignActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(showAgain), name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(captureChanged), name: UIScreen.capturedDidChangeNotification, object: nil)
    }

    /// Can this iPhone do Face ID or Touch ID right now?
    @objc func available(_ call: CAPPluginCall) {
        var err: NSError?
        let ok = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
        var reason = ""
        if !ok {
            switch LAError.Code(rawValue: err?.code ?? 0) {
            case .biometryNotEnrolled: reason = "Set up Face ID or Touch ID in Settings first."
            case .passcodeNotSet: reason = "Set a passcode on this iPhone first."
            case .biometryLockout: reason = "Face ID is locked. Unlock the iPhone with its passcode, then try again."
            default: reason = "This iPhone has no Face ID or Touch ID that Finance can use."
            }
        }
        call.resolve(["ok": ok, "reason": reason])
    }

    @objc func isSetUp(_ call: CAPPluginCall) {
        call.resolve(["setUp": UserDefaults.standard.bool(forKey: setUpKey) && FileManager.default.fileExists(atPath: file.path)])
    }

    /// First time: his face or finger, then a random data key kept behind it. → {key}
    @objc func create(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active else { call.reject("Open the app first.", "NOT_VISIBLE"); return }
            let context = LAContext()
            context.localizedCancelTitle = "Cancel"
            context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Face ID or Touch ID opens Finance on this phone") { ok, error in
                guard ok else { self.rejectAuth(call, error); return }
                var bytes = [UInt8](repeating: 0, count: 32)
                guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess,
                      let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil) else {
                    call.reject("Couldn't make a key on this phone.")
                    return
                }
                let key = Data(bytes)
                SecItemDelete(self.query() as CFDictionary)
                var add = self.query()
                add[kSecValueData as String] = key
                add[kSecAttrAccessControl as String] = access
                let status = SecItemAdd(add as CFDictionary, nil)
                guard status == errSecSuccess else { call.reject("Couldn't make a key on this phone (\(status))."); return }
                UserDefaults.standard.set(true, forKey: self.setUpKey)
                call.resolve(["key": key.base64EncodedString()])
            }
        }
    }

    /// Every time: his face or finger, then the data key. → {key}
    @objc func unlock(_ call: CAPPluginCall) {
        guard UserDefaults.standard.bool(forKey: setUpKey) else { call.reject("Finance isn't set up on this phone.", "NOT_SET_UP"); return }
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState == .active else { call.reject("Open the app first.", "NOT_VISIBLE"); return }
            let context = LAContext()
            context.localizedReason = "Open Finance"
            context.localizedCancelTitle = "Cancel"
            self.io.async {
                var q = self.query()
                q[kSecReturnData as String] = true
                q[kSecMatchLimit as String] = kSecMatchLimitOne
                q[kSecUseAuthenticationContext as String] = context
                var out: CFTypeRef?
                let status = SecItemCopyMatching(q as CFDictionary, &out)
                switch status {
                case errSecSuccess:
                    guard let key = out as? Data else { call.reject("Couldn't open Finance."); return }
                    call.resolve(["key": key.base64EncodedString()])
                case errSecUserCanceled:
                    call.reject("cancelled", "CANCELLED")
                case errSecItemNotFound:
                    // the key goes when a face or finger is added or removed
                    call.reject("Face ID or Touch ID changed on this iPhone, so Finance has to be paired again.", "INVALIDATED")
                case errSecAuthFailed:
                    call.reject("Face ID didn't unlock it. Try again.", "NOT_AUTHENTICATED")
                case errSecInteractionNotAllowed:
                    call.reject("Open the app first.", "NOT_VISIBLE")
                default:
                    call.reject("Couldn't open Finance (\(status)).")
                }
            }
        }
    }

    /// The encrypted vault (already encrypted by the page), in the app's own files, left out of backups.
    @objc func write(_ call: CAPPluginCall) {
        guard let data = call.getString("data") else { call.reject("nothing to write"); return }
        io.async {
            do {
                var url = self.file
                try Data(data.utf8).write(to: url, options: [.atomic, .completeFileProtection])
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try url.setResourceValues(values)
                call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func read(_ call: CAPPluginCall) {
        io.async {
            let url = self.file
            if let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) {
                call.resolve(["data": text])
            } else {
                call.resolve(["data": NSNull()])
            }
        }
    }

    /// Forget: the Keychain key and the vault file.
    @objc func forget(_ call: CAPPluginCall) {
        io.async {
            SecItemDelete(self.query() as CFDictionary)
            UserDefaults.standard.removeObject(forKey: self.setUpKey)
            try? FileManager.default.removeItem(at: self.file)
            call.resolve()
        }
    }

    /// While Finance is on screen: hidden in the app switcher and while the screen is being recorded or
    /// mirrored. (iOS gives apps no way to block a screenshot.)
    @objc func secure(_ call: CAPPluginCall) {
        let on = call.getBool("on", false)
        DispatchQueue.main.async {
            self.secureOn = on
            if on { if UIScreen.main.isCaptured { self.showCover() } } else { self.hideCover() }
            call.resolve()
        }
    }

    @objc private func hideForSwitcher() { if secureOn { showCover() } }
    @objc private func showAgain() { if !(secureOn && UIScreen.main.isCaptured) { hideCover() } }
    @objc private func captureChanged() {
        if secureOn && UIScreen.main.isCaptured { showCover() } else if UIApplication.shared.applicationState == .active { hideCover() }
    }

    private func showCover() {
        guard cover == nil, let window = bridge?.viewController?.view.window else { return }
        let v = UIView(frame: window.bounds)
        v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        v.backgroundColor = .systemBackground
        let label = UILabel()
        label.text = "Finance is hidden"
        label.textColor = .secondaryLabel
        label.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(label)
        NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: v.centerXAnchor), label.centerYAnchor.constraint(equalTo: v.centerYAnchor)])
        window.addSubview(v)
        cover = v
    }

    private func hideCover() {
        cover?.removeFromSuperview()
        cover = nil
    }

    /// The pairing QR code from the computer's Finance tab. → {text}
    @objc func scan(_ call: CAPPluginCall) {
        AVCaptureDevice.requestAccess(for: .video) { ok in
            DispatchQueue.main.async {
                guard ok else { call.reject("Camera access is off for Romulus. Turn it on in Settings > Romulus to scan the code."); return }
                guard let top = self.bridge?.viewController else { call.reject("Open the app first.", "NOT_VISIBLE"); return }
                let scanner = QRScanViewController()
                scanner.done = { text in
                    top.dismiss(animated: true)
                    if let text { call.resolve(["text": text]) } else { call.reject("cancelled", "CANCELLED") }
                }
                scanner.modalPresentationStyle = .fullScreen
                top.present(scanner, animated: true)
            }
        }
    }

    /// A GET to SimpleFIN or Yahoo Finance only, over HTTPS, no redirects. → {status, body}
    @objc func http(_ call: CAPPluginCall) {
        guard let url = URL(string: call.getString("url", "")), url.scheme == "https", let host = url.host?.lowercased(),
              host == "simplefin.org" || host.hasSuffix(".simplefin.org") || host == "query1.finance.yahoo.com" else {
            call.reject("not an address Finance talks to")
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 90)
        for (k, v) in call.getObject("headers", [:]) { if let s = v as? String { req.setValue(s, forHTTPHeaderField: k) } }
        NoRedirects.session.dataTask(with: req) { data, response, error in
            guard let http = response as? HTTPURLResponse else {
                call.reject("offline: " + (error?.localizedDescription ?? "no response"), "OFFLINE")
                return
            }
            let body = data.map { String(decoding: $0.prefix(30 * 1024 * 1024), as: UTF8.self) } ?? ""
            call.resolve(["status": http.statusCode, "body": body])
        }.resume()
    }

    private func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    private func rejectAuth(_ call: CAPPluginCall, _ error: Error?) {
        let code = LAError.Code(rawValue: (error as NSError?)?.code ?? 0)
        switch code {
        case .userCancel, .userFallback: call.reject("cancelled", "CANCELLED")
        case .appCancel, .systemCancel: call.reject("Open the app first.", "NOT_VISIBLE")
        case .biometryLockout: call.reject("Face ID is locked. Unlock the iPhone with its passcode, then try again.", "BIOMETRIC_LOCKOUT")
        default: call.reject(error?.localizedDescription ?? "Face ID didn't work.", "BIOMETRIC_\(code?.rawValue ?? 0)")
        }
    }
}

/// URLSession that never follows a redirect (Finance's requests must land where they were sent).
final class NoRedirects: NSObject, URLSessionTaskDelegate {
    static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 90
        return URLSession(configuration: c, delegate: NoRedirects(), delegateQueue: nil)
    }()

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Full-screen camera that reads one QR code.
final class QRScanViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var done: ((String?) -> Void)?
    private let session = AVCaptureSession()
    private var finished = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { finish(nil); return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { finish(nil); return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.layer.bounds
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        cancel.tintColor = .white
        cancel.backgroundColor = UIColor.black.withAlphaComponent(0.5)
        cancel.layer.cornerRadius = 10
        cancel.contentEdgeInsets = UIEdgeInsets(top: 10, left: 20, bottom: 10, right: 20)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        view.addSubview(cancel)
        let hint = UILabel()
        hint.text = "Point the camera at the code on your computer"
        hint.textColor = .white
        hint.numberOfLines = 0
        hint.textAlignment = .center
        hint.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hint)
        NSLayoutConstraint.activate([
            cancel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cancel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            hint.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            hint.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            hint.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24)
        ])
        DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.layer.sublayers?.compactMap { $0 as? AVCaptureVideoPreviewLayer }.forEach { $0.frame = view.layer.bounds }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let code = objects.first as? AVMetadataMachineReadableCodeObject, let text = code.stringValue else { return }
        finish(text)
    }

    @objc private func cancelTapped() { finish(nil) }

    private func finish(_ text: String?) {
        guard !finished else { return }
        finished = true
        DispatchQueue.global(qos: .userInitiated).async { self.session.stopRunning() }
        DispatchQueue.main.async { self.done?(text) }
    }
}
