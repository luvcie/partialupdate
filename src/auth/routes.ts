import type { AppEnv } from "../env";
import {
  createAuth,
  getAuthSession,
  hasProviderCredentials,
  type AuthProvider,
} from "./server";

const authHtmlHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
};

export function isAuthRoute(pathname: string): boolean {
  return (
    pathname === "/sign-up" ||
    pathname === "/private-hello" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/auth/sign-in/")
  );
}

export async function handleAuthRoute(
  request: Request,
  env: AppEnv,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/auth/")) {
    if (
      request.method === "POST" &&
      url.pathname === "/api/auth/sign-in/social"
    ) {
      return new Response("Use /sign-up to start social sign up.", {
        status: 403,
      });
    }

    return createAuth(request, env).handler(request);
  }

  if (request.method === "GET" && url.pathname === "/sign-up") {
    return new Response(renderSignUpPage(env), { headers: authHtmlHeaders });
  }

  if (request.method === "POST" && url.pathname.startsWith("/auth/sign-in/")) {
    const provider = parseProvider(url.pathname);

    if (!provider) {
      return new Response("Unknown auth provider", { status: 404 });
    }

    return startSocialSignIn(request, env, provider);
  }

  if (request.method === "GET" && url.pathname === "/private-hello") {
    const session = await getAuthSession(request, env);

    if (!session) {
      return Response.redirect(new URL("/sign-up", url.origin).toString(), 302);
    }

    return new Response("hello world", {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  return new Response("Not found", { status: 404 });
}

async function startSocialSignIn(
  request: Request,
  env: AppEnv,
  provider: AuthProvider,
): Promise<Response> {
  const form = await request.formData();
  const privacyOk = form.get("privacyOk") === "on";
  const necessaryCookieConsent = form.get("necessaryCookieConsent") === "on";

  if (!privacyOk || !necessaryCookieConsent) {
    return new Response(renderSignUpPage(env, "Please confirm both consent options."), {
      headers: authHtmlHeaders,
      status: 400,
    });
  }

  if (!hasProviderCredentials(env, provider)) {
    return new Response(
      renderSignUpPage(env, `The ${provider} provider is not configured yet.`),
      {
        headers: authHtmlHeaders,
        status: 503,
      },
    );
  }

  const url = new URL(request.url);
  const authRequest = new Request(
    new URL("/api/auth/sign-in/social", url.origin).toString(),
    {
      body: JSON.stringify({
        callbackURL: "/private-hello",
        errorCallbackURL: "/sign-up",
        newUserCallbackURL: "/private-hello",
        provider,
        requestSignUp: true,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );
  const authResponse = await createAuth(request, env).handler(authRequest);
  const data = (await authResponse.json()) as {
    redirect?: boolean;
    url?: string;
  };

  if (!data.url) {
    return new Response("Unable to start sign in", { status: 500 });
  }

  const response = new Response(null, {
    headers: {
      Location: data.url,
    },
    status: 303,
  });
  appendSetCookieHeaders(response.headers, authResponse.headers);
  return response;
}

function parseProvider(pathname: string): AuthProvider | null {
  const provider = pathname.split("/").filter(Boolean).at(-1);
  return provider === "github" || provider === "google" ? provider : null;
}

function appendSetCookieHeaders(target: Headers, source: Headers): void {
  const withGetSetCookie = source as Headers & {
    getSetCookie?: () => string[];
  };
  const cookies = withGetSetCookie.getSetCookie?.();

  if (cookies?.length) {
    for (const cookie of cookies) {
      target.append("Set-Cookie", cookie);
    }
    return;
  }

  const cookie = source.get("Set-Cookie");

  if (cookie) {
    target.append("Set-Cookie", cookie);
  }
}

function renderSignUpPage(env: AppEnv, error = ""): string {
  const githubEnabled = hasProviderCredentials(env, "github");
  const googleEnabled = hasProviderCredentials(env, "google");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sign up - PartialUpdate</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        align-items: center;
        background: Canvas;
        color: CanvasText;
        display: flex;
        margin: 0;
        min-height: 100vh;
        padding: 24px;
      }

      main {
        margin: 0 auto;
        max-width: 420px;
        width: 100%;
      }

      h1 {
        font-size: 2rem;
        line-height: 1.1;
        margin: 0 0 12px;
      }

      p {
        line-height: 1.5;
        margin: 0 0 20px;
      }

      form {
        border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
        border-radius: 8px;
        display: grid;
        gap: 16px;
        padding: 20px;
      }

      label {
        display: flex;
        gap: 10px;
        line-height: 1.4;
      }

      button {
        border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        min-height: 44px;
        padding: 0 14px;
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      .actions {
        display: grid;
        gap: 10px;
      }

      .error {
        color: #b42318;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Sign up</h1>
      <p>Create a PartialUpdate account with GitHub or Google.</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <form method="post">
        <label>
          <input type="checkbox" name="privacyOk" required />
          <span>I agree to the privacy terms for storing my name and email.</span>
        </label>
        <label>
          <input type="checkbox" name="necessaryCookieConsent" required />
          <span>I consent to necessary authentication cookies.</span>
        </label>
        <div class="actions">
          <button type="submit" formaction="/auth/sign-in/github" ${githubEnabled ? "" : "disabled"}>Continue with GitHub</button>
          <button type="submit" formaction="/auth/sign-in/google" ${googleEnabled ? "" : "disabled"}>Continue with Google</button>
        </div>
      </form>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
