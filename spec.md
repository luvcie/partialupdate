This is a V2 migration of frontclaw however it has a slightly different architecture.

1. Rather than keeping the initial stream open we close it.
2. Updates from the server happen via websockets from the DO. We will use Cloudflare hibernatable WS. We will also need to use their automatic ping/pong lets DO sleep while ping/pong continues.
3. We continue to use the form submission to a hidden iframe.
4. we also want to keep the debug view so we can see message history in the format the LLM uses

## Message format

In frontclaw LLM responses where of the format <template><div>...</div></template> in the new system we the LLM will add a JSON wrapper:

type Update = {
clients: {
mode: 'include' | 'exclude',
ids: string[],
};
type: string;
path: string;
payload: string;
};

E.g. this would send the following template to all clients. On arrival at a client this would append the payload to the body of the page.

{
clients: {mode: 'exclude', ids: []},
path: '/body',
type: 'html'
payload: '<template>...</template>'
}

This would send an update to an instance of Tic Tac Toe game running in JS:

{
clients: {mode: 'exclude', ids: []},
path: '/tictactoe/45',
type: 'json'
payload: '{"pos": 8, "player": 0}'
}

So in this version the LLM acts as a bit of an exchange. Most of the time it will forward messages to all clients but it can decide to send to one, a selection or no clients (E.g. secret random numbers):

{
clients: {mode: 'include', ids: []},
path: '/secret',
type: 'json'
payload: '["paper", "stone", "paper", "scissors"]'
}

a response can have more than one JSON object as NDJSON:

{
clients: {mode: 'exclude', ids: []},
path: '/body',
type: 'html'
payload: '<template>...</template>'
}
{
clients: {mode: 'include', ids: []},
path: '/secret',
type: 'json'
payload: '["paper", "stone", "paper", "scissors"]'
}

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
