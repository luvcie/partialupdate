This is a V2 migration of frontclaw however it has a slightly different architecture.

1. Rather than keeping the initial stream open we close it.
2. Updates from the server happen via websockets from the DO. We will use Cloudflare hibernatable WS. We will also need to use their automatic ping/pong lets DO sleep while ping/pong continues.
3. We continue to use the form submission to a hidden iframe.
4. we also want to keep the debug view so we can see message history in the format the LLM uses

## Message format

LLM responses use a JSX-like JSON format so HTML does not need to be escaped into a JSON string. A response can contain more than one update object, one after another.

This sends HTML to all clients:

{
  headers: {
    vars: { clientId: 1, chatId: "fb14dkt" },
    config: {
      clients: { mode: "exclude", ids: [] },
      path: "/body",
      type: "html",
    }
  },
  body:
<template for="/app/messages/append">
  <div class="message message-user" data-client-id={clientId}>What is 2 + 2?</div>
  <div class="message message-agent">2 + 2 = 4</div>
  <?marker name="/app/messages/append">
</template>
}

This sends an update to a JavaScript app subscription:

{
  headers: {
    vars: { clientId: 1, chatId: "fb14dkt" },
    config: {
      clients: { mode: "exclude", ids: [] },
      path: "/app/tictactoe/45",
      type: "pogo",
    }
  },
  body: {
    pos: 8,
    player: 0,
    source: `/${chatId}/move/${clientId}`
  }
}

The LLM acts as a small exchange. Most updates go to all clients, but `clients` can include only selected clients, exclude selected clients, or include no clients for private state that should remain in LLM history.

`vars` are available in HTML expressions and POGO bodies. The parser supports direct identifiers, string concatenation, and template interpolation. Marker names should use path-like names such as `/app/tictactoe/1`.

## Events

These events coming from the server should be available on the client to be subscribed to. E.g. this is how we will insert templates.

```js
const unsubscribe = window.partialupdates.subscribe(
  new Subscription(
    (x) => x.path === "/body" && x.type === "html",
    (e) => {
      document.body.insertAdjacentHTML("beforeend", e.payload);
    },
  ),
);
```

We want this to work in all browser so we will use the polyfill:

<script src="https://unpkg.com/template-for-polyfill"></script>

## Wrangler

We need all pretty much the same structure in wrangler and package.json but with the name partialupdate. Reuse the same code for LLM selection, secrets and settings
