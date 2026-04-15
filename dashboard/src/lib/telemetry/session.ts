export function getSessionId(): string {
  if (typeof window === "undefined") return "";
  let id = sessionStorage.getItem("tel-session");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("tel-session", id);
  }
  return id;
}

export function newTraceId(): string {
  return crypto.randomUUID();
}
