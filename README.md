# Partial Update

A multi user AI chat that generates its own UI on the fly.

<img width="720" alt="martix" src="https://github.com/user-attachments/assets/6ff33272-1bb0-4551-a296-3481e243015f" />

Based on the new [Dynamic Partial Update](https://developer.chrome.com/blog/declarative-partial-updates) spec.

```html
<div class="chat">
  <div class="message user">Hi I am Phil</div>
  <div class="message agent">Welcome Phil</div>
  <?marker name="append-message">
</div>
... <!-- a few seconds later -->
<template for="append-message">
  <div class="message user">What is 2 + 2?</div>
  <div class="message agent">2 + 2 = 4</div>
  <?marker name="append-message">
</template>
```

The LLM responds with HTML not markdown so the response can include SVG, CSS, JS, MathML etc. This can be applied in various template areas.

<img width="1024" alt="julia2" src="https://github.com/user-attachments/assets/95ab8fb8-2451-42b5-84dd-e82d0bc69f18" />

The output can contain forms that submit their response back to the LLM. Allowing users to prompt with structured data.
<div align="center">
<img width="720" alt="name" src="https://github.com/user-attachments/assets/e128e38f-1f4e-4830-8e8d-e6062be30563" style="display: block; margin: 0 auto;" />
</div>



<img width="720" alt="wikipedia" src="https://github.com/user-attachments/assets/4f50ce1f-cd94-415b-aa6d-d4623eb0da05" />

