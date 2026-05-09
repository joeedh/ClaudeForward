const form = document.getElementById("login-form") as HTMLFormElement;
const errorEl = document.getElementById("login-error") as HTMLParagraphElement;
const tokenInput = document.getElementById("token") as HTMLInputElement;

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  const token = tokenInput.value.trim();
  if (!token) return;

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "same-origin",
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      errorEl.textContent = body.error ?? `login failed (${res.status})`;
      errorEl.hidden = false;
      return;
    }
    location.href = "/";
  } catch (err) {
    errorEl.textContent = (err as Error).message;
    errorEl.hidden = false;
  }
});
