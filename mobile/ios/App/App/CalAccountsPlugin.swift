import Foundation
import UIKit
import AuthenticationServices
import CryptoKit
import Security
import Capacitor

/// Calendar accounts on the iPhone: Google and Microsoft sign-in, plus calendar links (.ics). The phone side
/// of agent/calendars.js (CalAccountsPlugin.java on Android). Sign-in opens Apple's sign-in sheet
/// (ASWebAuthenticationSession) with PKCE and comes back on a redirect only this app gets:
/// Google: com.googleusercontent.apps.<client>:/oauth2redirect, from an iOS-type OAuth client;
/// Microsoft: msauth.com.jartro.tasks://auth, from the Entra app's iOS platform.
///
/// Tokens and calendar links stay in this app's Keychain and never reach the page: it asks for calendar
/// data through api() and feed(), which add the token themselves and only talk to the Google Calendar and
/// Microsoft Graph APIs.
@objc(CalAccountsPlugin)
public class CalAccountsPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "CalAccountsPlugin"
    public let jsName = "CalAccounts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "api", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "feed", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addLink", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private static let googleAuth = "https://accounts.google.com/o/oauth2/v2/auth"
    private static let googleToken = "https://oauth2.googleapis.com/token"
    private static let googleAPI = "https://www.googleapis.com/calendar/v3/"
    // read-only on the phone: the desktop app is the one that puts tasks on a calendar
    private static let googleScope = "openid email https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly"
    private static let msAuth = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    private static let msToken = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    private static let msAPI = "https://graph.microsoft.com/v1.0/"
    private static let msScope = "openid email profile offline_access User.Read Calendars.Read"

    private let store = DispatchQueue(label: "cal.accounts") // every read-modify-write of the account list
    private var session: ASWebAuthenticationSession?

    /* ---------- sign-in ---------- */

    @objc func connect(_ call: CAPPluginCall) {
        let provider = call.getString("provider", "")
        guard provider == "google" || provider == "microsoft" else { call.resolve(fail("Unknown provider")); return }
        guard let clientId = clientId(provider), let redirect = redirectUri(provider, clientId) else {
            var r = fail((provider == "google" ? "Google" : "Microsoft") + " sign-in isn’t set up in this build.")
            r["needsClient"] = true
            call.resolve(r)
            return
        }
        let verifier = b64url(random(32))
        let challenge = b64url(Data(SHA256.hash(data: Data(verifier.utf8))))
        let state = hex(random(16))
        var c = URLComponents(string: provider == "google" ? Self.googleAuth : Self.msAuth)!
        c.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirect),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: provider == "google" ? Self.googleScope : Self.msScope),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "prompt", value: provider == "google" ? "consent" : "select_account")
        ]
        guard let url = c.url, let scheme = URL(string: redirect)?.scheme else { call.resolve(fail("Sign-in failed.")); return }

        DispatchQueue.main.async {
            self.session?.cancel()
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { back, error in
                self.session = nil
                guard let back else {
                    let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                    call.resolve(self.fail(cancelled ? "Sign-in was cancelled." : (error?.localizedDescription ?? "Sign-in failed.")))
                    return
                }
                Task {
                    let r: [String: Any]
                    do { r = try await self.exchange(back, provider: provider, clientId: clientId, redirect: redirect, verifier: verifier, state: state) }
                    catch { r = self.fail(error.localizedDescription) }
                    call.resolve(r)
                }
            }
            s.presentationContextProvider = self
            s.prefersEphemeralWebBrowserSession = true // no shared Safari cookies: he picks the account each time
            self.session = s
            if !s.start() { self.session = nil; call.resolve(self.fail("Could not open the sign-in page.")) }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    private func exchange(_ back: URL, provider: String, clientId: String, redirect: String, verifier: String, state: String) async throws -> [String: Any] {
        let q = URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in q.first(where: { $0.name == name })?.value }
        if let err = value("error_description") ?? value("error") { return fail(err) }
        guard let code = value("code"), value("state") == state else { return fail("Invalid response from the sign-in page.") }
        var form = ["code": code, "client_id": clientId, "redirect_uri": redirect, "grant_type": "authorization_code", "code_verifier": verifier]
        if provider == "microsoft" { form["scope"] = Self.msScope }
        let (status, body) = try await post(provider == "google" ? Self.googleToken : Self.msToken, form)
        let td = json(body)
        guard status == 200 else { return fail(td["error_description"] as? String ?? td["error"] as? String ?? "Token exchange failed.") }
        guard let access = td["access_token"] as? String, let refresh = td["refresh_token"] as? String else {
            return fail((provider == "google" ? "Google" : "Microsoft") + " did not return a refresh token. Remove the app’s access in your account settings and try again.")
        }
        let email = idTokenEmail(td["id_token"] as? String ?? "")
        let expires = (td["expires_in"] as? Double) ?? 3600
        return store.sync { () -> [String: Any] in
            var list = accounts()
            // signing in again with the same account refreshes it instead of adding a copy
            var i = list.firstIndex { ($0["provider"] as? String) == provider && email != nil && (($0["email"] as? String)?.lowercased() == email!.lowercased()) }
            if i == nil {
                list.append(["id": "\(provider.prefix(1))-\(hex(random(4)))", "provider": provider])
                i = list.count - 1
            }
            var a = list[i!]
            if let email { a["email"] = email }
            a["scope"] = td["scope"] as? String ?? ""
            a["tokens"] = ["access_token": access, "refresh_token": refresh, "expiry_date": now() + expires * 1000]
            a.removeValue(forKey: "broken")
            list[i!] = a
            save(list)
            var r: [String: Any] = ["ok": true, "id": a["id"] as? String ?? ""]
            if let email { r["email"] = email } else { r["email"] = NSNull() }
            return r
        }
    }

    /* ---------- what the page may ask ---------- */

    /// The connected accounts, without tokens or links.
    @objc func list(_ call: CAPPluginCall) {
        let out: [[String: Any]] = store.sync {
            accounts().map { a -> [String: Any] in
                var o: [String: Any] = [:]
                for k in ["id", "provider", "email", "name", "broken"] { if let v = a[k] { o[k] = v } }
                // to-do ids hash this, so the desktop gives the same event the same id (calendars.js pullKey)
                let provider = a["provider"] as? String ?? ""
                if provider == "ics" { o["key"] = "ics:" + (a["url"] as? String ?? "") }
                else if let email = a["email"] as? String { o["key"] = provider + ":" + email.lowercased() }
                else { o["key"] = a["id"] as? String ?? "" }
                return o
            }
        }
        call.resolve(["accounts": out, "builtIn": ["google": clientId("google") != nil, "microsoft": clientId("microsoft") != nil]])
    }

    /// One Google Calendar / Microsoft Graph read for an account: {id, path} → {status, body}.
    @objc func api(_ call: CAPPluginCall) {
        let id = call.getString("id", ""), path = call.getString("path", "")
        Task {
            do {
                guard let a = find(id) else { call.reject("That account is no longer connected"); return }
                let provider = a["provider"] as? String
                guard let base = provider == "google" ? Self.googleAPI : provider == "microsoft" ? Self.msAPI : nil else {
                    call.reject("Not a sign-in account"); return
                }
                let url = path.hasPrefix(base) ? path : base + path.replacingOccurrences(of: "^/+", with: "", options: .regularExpression)
                guard !url.contains(".."), url.hasPrefix(base) else { call.reject("Not a calendar request"); return }
                var res = try await get(url, token: try await token(id, force: false))
                if res.status == 401 { res = try await get(url, token: try await token(id, force: true)) }
                call.resolve(["status": res.status, "body": res.body])
            } catch { call.reject(error.localizedDescription) }
        }
    }

    /// A calendar link's contents: {id} → {status, body}.
    @objc func feed(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        Task {
            do {
                guard let a = find(id), (a["provider"] as? String) == "ics", let link = a["url"] as? String else {
                    call.reject("That calendar link is gone"); return
                }
                let res = try await getText(link)
                call.resolve(["status": res.status, "body": res.body])
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func addLink(_ call: CAPPluginCall) {
        let link = call.getString("url", "").trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "^webcals?://", with: "https://", options: [.regularExpression, .caseInsensitive])
        let name = String(call.getString("name", "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
        guard let u = URL(string: link), u.scheme == "https", let host = u.host else { call.resolve(fail("Use an https:// or webcal:// link.")); return }
        Task {
            let res: (status: Int, body: String)
            do { res = try await getText(link) } catch { call.resolve(fail("Couldn’t read it: " + error.localizedDescription)); return }
            guard res.status == 200, res.body.contains("BEGIN:VCALENDAR") else {
                call.resolve(fail("Couldn’t read it: " + (res.status == 200 ? "not a calendar" : "HTTP \(res.status)"))); return
            }
            let r: [String: Any] = store.sync { () -> [String: Any] in
                var list = accounts()
                if list.contains(where: { ($0["url"] as? String) == link }) { return fail("Already added.") }
                let id = "i-" + hex(random(4))
                list.append(["id": id, "provider": "ics", "url": link, "name": name.isEmpty ? host : name])
                save(list)
                return ["ok": true, "id": id]
            }
            call.resolve(r)
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        store.sync { save(accounts().filter { ($0["id"] as? String) != id }) }
        call.resolve()
    }

    /* ---------- tokens ---------- */

    private func token(_ id: String, force: Bool) async throws -> String {
        guard let a = find(id) else { throw Failure("That account is no longer connected") }
        let t = a["tokens"] as? [String: Any] ?? [:]
        if !force, let access = t["access_token"] as? String, (t["expiry_date"] as? Double ?? 0) > now() + 60000 { return access }
        guard let refresh = t["refresh_token"] as? String else { throw Failure("Sign in again") }
        let provider = a["provider"] as? String ?? ""
        guard let clientId = clientId(provider) else { throw Failure("Sign-in isn’t set up in this build") }
        var form = ["client_id": clientId, "refresh_token": refresh, "grant_type": "refresh_token"]
        if provider == "microsoft" { form["scope"] = Self.msScope }
        let (status, body) = try await post(provider == "google" ? Self.googleToken : Self.msToken, form)
        let d = json(body)
        return try store.sync { () throws -> String in
            var list = accounts()
            guard let i = list.firstIndex(where: { ($0["id"] as? String) == id }) else { throw Failure("That account is no longer connected") }
            guard status == 200, let access = d["access_token"] as? String else {
                if (d["error"] as? String) == "invalid_grant" { list[i]["broken"] = true; save(list) }
                throw Failure(d["error_description"] as? String ?? d["error"] as? String ?? "Token refresh failed")
            }
            var nt = list[i]["tokens"] as? [String: Any] ?? [:]
            nt["access_token"] = access
            nt["expiry_date"] = now() + ((d["expires_in"] as? Double) ?? 3600) * 1000
            if let r = d["refresh_token"] as? String { nt["refresh_token"] = r }
            list[i]["tokens"] = nt
            list[i].removeValue(forKey: "broken")
            save(list)
            return access
        }
    }

    /* ---------- storage: one Keychain item, this device only ---------- */

    private var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.jartro.tasks.cal", kSecAttrAccount as String: "accounts"]
    }

    private func accounts() -> [[String: Any]] {
        var q = keychainQuery
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return list
    }

    private func save(_ list: [[String: Any]]) {
        guard let data = try? JSONSerialization.data(withJSONObject: list) else { return }
        let update: [String: Any] = [kSecValueData as String: data]
        if SecItemUpdate(keychainQuery as CFDictionary, update as CFDictionary) == errSecItemNotFound {
            var add = keychainQuery
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    private func find(_ id: String) -> [String: Any]? { store.sync { accounts().first { ($0["id"] as? String) == id } } }

    /// oauth_clients.json in the app, written by prepare-www.js from oauth-clients.json.
    private func clientId(_ provider: String) -> String? {
        guard let url = Bundle.main.url(forResource: "oauth_clients", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let all = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let one = all[provider] as? [String: Any], let id = one["clientId"] as? String, !id.isEmpty else { return nil }
        return id
    }

    private func redirectUri(_ provider: String, _ clientId: String) -> String? {
        if provider == "google" {
            // an iOS-type client: its reversed id is the scheme
            guard clientId.hasSuffix(".apps.googleusercontent.com") else { return nil }
            let prefix = clientId.replacingOccurrences(of: ".apps.googleusercontent.com", with: "")
            return "com.googleusercontent.apps.\(prefix):/oauth2redirect"
        }
        return "msauth.\(Bundle.main.bundleIdentifier ?? "com.jartro.tasks")://auth"
    }

    /* ---------- http ---------- */

    private func post(_ url: String, _ form: [String: String]) async throws -> (status: Int, body: String) {
        var req = URLRequest(url: URL(string: url)!, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = Data(form.map { "\(enc($0.key))=\(enc($0.value))" }.joined(separator: "&").utf8)
        return try await send(req, max: 1 << 20)
    }

    private func get(_ url: String, token: String) async throws -> (status: Int, body: String) {
        guard let u = URL(string: url) else { throw Failure("Not a calendar request") }
        var req = URLRequest(url: u, timeoutInterval: 20)
        req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if url.hasPrefix(Self.msAPI) { req.setValue("outlook.timezone=\"UTC\"", forHTTPHeaderField: "Prefer") }
        return try await send(req, max: 8 << 20)
    }

    private func getText(_ url: String) async throws -> (status: Int, body: String) {
        guard let u = URL(string: url) else { throw Failure("Not a link") }
        var req = URLRequest(url: u, timeoutInterval: 20)
        req.setValue("text/calendar", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: req)
        if response.url?.scheme != "https" { throw Failure("redirected off https") }
        guard data.count <= 8 << 20 else { throw Failure("response too large") }
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, String(decoding: data, as: UTF8.self))
    }

    private func send(_ req: URLRequest, max: Int) async throws -> (status: Int, body: String) {
        let (data, response) = try await URLSession.shared.data(for: req)
        guard data.count <= max else { throw Failure("response too large") }
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, String(decoding: data, as: UTF8.self))
    }

    /* ---------- small helpers ---------- */

    private struct Failure: LocalizedError {
        let message: String
        init(_ m: String) { message = m }
        var errorDescription: String? { message }
    }

    private func fail(_ msg: String?) -> [String: Any] { ["ok": false, "error": msg ?? "Sign-in failed."] }
    private func json(_ s: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any]) ?? [:]
    }
    private func now() -> Double { Date().timeIntervalSince1970 * 1000 }
    private func enc(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }
    private func random(_ n: Int) -> Data {
        var b = [UInt8](repeating: 0, count: n)
        _ = SecRandomCopyBytes(kSecRandomDefault, n, &b)
        return Data(b)
    }
    private func b64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
    private func idTokenEmail(_ idToken: String) -> String? {
        let parts = idToken.split(separator: ".")
        guard parts.count > 1 else { return nil }
        var s = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        guard let data = Data(base64Encoded: s), let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let e = (o["email"] as? String) ?? (o["preferred_username"] as? String) ?? ""
        return e.isEmpty ? nil : e
    }
}
