/**
 * Browser notifications for this device. Some browsers have none (a phone
 * browser tab often), a denied permission can only be changed in the browser's
 * site settings, and Android Chrome shows them only through a service worker.
 */
export type NotifySupport = "unsupported" | "default" | "granted" | "denied";

export function notifySupport(): NotifySupport {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Whether notifications are turned on for this device (the settings switch). */
export function notifyOn(): boolean {
  try { return localStorage.getItem("farmer.notify") === "true"; } catch { return false; }
}

/** Shows one notification; a browser that refuses never breaks the page. */
export function showNotification(title: string, body: string, tag = "farmer-brief"): void {
  if (notifySupport() !== "granted") return;
  const options = { body, tag };
  try {
    const shown = new Notification(title, options);
    shown.onclick = () => { window.focus(); shown.close(); };
  } catch {
    // "Illegal constructor" on Android: only a registered service worker may show it.
    void navigator.serviceWorker?.getRegistration().then((reg) => reg?.showNotification(title, options)).catch(() => undefined);
  }
}
