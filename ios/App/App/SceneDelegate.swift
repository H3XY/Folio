import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

        // Cold start from Files' "Open With": Capacitor delivers the original URL once its plugins are ready;
        // deliver Folio's readable copy right after it, so the launch URL the web layer reads is the copy.
        let copies = connectionOptions.urlContexts.filter(Self.isInPlace).compactMap { Self.copyToInbox($0.url) }
        if !copies.isEmpty {
            var token: NSObjectProtocol?
            token = NotificationCenter.default.addObserver(forName: .capacitorViewDidAppear, object: nil, queue: .main) { _ in
                if let token { NotificationCenter.default.removeObserver(token) }
                copies.forEach { _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: $0) }
            }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            if Self.isInPlace(context), let copy = Self.copyToInbox(context.url) {
                _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: copy)
            } else {
                SceneDelegateProxy.shared.scene(scene, openURLContexts: [context])
            }
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    // Folio declares LSSupportsOpeningDocumentsInPlace so it appears under Files' "Open With". Files opened that way
    // arrive as security-scoped links to the user's original document, which the web layer can't read, so Folio
    // works on a private copy. (Saving always goes through the share sheet; the original is never modified.)
    private static func isInPlace(_ context: UIOpenURLContext) -> Bool {
        context.url.isFileURL && context.options.openInPlace
    }

    private static func copyToInbox(_ url: URL) -> URL? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("Opened", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let dest = folder.appendingPathComponent(url.lastPathComponent)
        var coordinationError: NSError?
        var copyError: Error?
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            NSLog("Folio: could not create inbox: \(error)")
            return nil
        }
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { readURL in
            do { try FileManager.default.copyItem(at: readURL, to: dest) } catch { copyError = error }
        }
        if let error = coordinationError ?? copyError {
            NSLog("Folio: could not copy opened document: \(error)")
            return nil
        }
        return dest
    }
}
