# PayPal AI-Toolkit review — raw output (2026-10-31)

Headless Claude Code sessions with the official PayPal AI-Toolkit plugin (`paypal` 1.2.0, commit `1401791`) loaded with
`--plugin-dir`, read-only (`--allowedTools Skill,Read,Grep,Glob`), over a copy of `src/` at commit `4e11af4`. The output is in
Spanish (the author's locale) and is reproduced verbatim. English summary and the resulting changes:
[`paypal-ai-toolkit.md`](./paypal-ai-toolkit.md).

---

## 1. `/paypal:doctor full`

# PayPal Doctor — Modo: full

La integración está bien hecha en general: 2 problemas críticos, 5 avisos y 23 comprobaciones superadas. Los dos críticos son:

- **Un rechazo del método de pago (`INSTRUMENT_DECLINED`) deja al comprador bloqueado en el drop para siempre.**
- **Una captura que PayPal deja en `PENDING` nunca se completa ni se liquida**, porque los webhooks de captura solo se registran en el log y no cambian el estado.

Es una copia de solo lectura, así que no he modificado nada. Abajo van los cambios propuestos como texto. Tampoco he hecho las pruebas contra el API real (MCP), por la misma razón.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PayPal Doctor Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[CREDENCIALES Y SEGURIDAD]
  [✓] El secreto solo sale de variables de entorno, validado con zod (src/server/env.ts:5)
  [✓] Al navegador solo llega el clientId, que es público por diseño (src/server/index.ts:82)
  [✓] El token no se escribe en logs; el log del SDK está apagado por defecto y oculta cabeceras (src/server/paypal.ts:27-30)
  [ℹ] INFO     — No he podido comprobar .gitignore ni .env: no están en la copia y la política prohíbe abrirlos
  [⚠] WARNING  — HASH_SECRET tiene un valor por defecto público; los hashes de payer y email se pueden reproducir (src/server/env.ts:14)
  [ℹ] INFO     — El enlace del vendedor, con su token, se imprime en consola y en un fichero (src/server/index.ts:317-323)
  [ℹ] INFO     — No hay PAYPAL_ENVIRONMENT; es intencional (solo sandbox), pero haría falta antes de producción

[AUTENTICACIÓN Y TOKENS]
  [✓] El SDK servidor gestiona OAuth para Orders y Payments
  [✓] Token REST en caché con margen de 60 s y una sola petición en vuelo (src/server/paypal.ts:231-237)
  [✓] Basic Auth y grant_type=client_credentials (src/server/paypal.ts:239-245)
  [✓] PayPal-Request-Id en todos los POST, único por operación lógica (create:, auth:, cap:…:1, void:, negtest:)
  [ℹ] INFO     — Si llega un 401, el token en caché no se invalida (src/server/paypal.ts:254-263)

[ORDERS API Y CHECKOUT]
  [✓] Orders v2 con intent AUTHORIZE, currencyCode y breakdown que cuadra (src/server/paypal.ts:110-131)
  [✓] El importe se calcula en el servidor, no en el navegador
  [✓] Comprueba APPROVED antes de autorizar; captura parcial con finalCapture=true (src/server/domain.ts:187, src/server/paypal.ts:205)
  [✓] onApprove, onCancel y onError implementados (src/web/components.tsx:200-226)
  [✗] CRITICAL — INSTRUMENT_DECLINED se trata como error terminal y deja al pagador bloqueado (src/server/domain.ts:558-560 + db.ts:64)
  [⚠] WARNING  — No se comprueba el estado de la autorización: una DENIED queda marcada como "held" (src/server/domain.ts:510-513)
  [⚠] WARNING  — return_url y cancel_url son HTTP por defecto y nada exige HTTPS fuera de localhost (src/server/env.ts:11, domain.ts:151-152)

[JS SDK v6]  (detectado: loadCoreSdkScript / createInstance / <paypal-button>; ninguna señal de v5)
  [✓] Cargador oficial @paypal/paypal-js/sdk-v6, sandbox, inyección asíncrona (src/web/components.tsx:176)
  [✓] Sin mezcla con el SDK v5
  [✓] createInstance con clientId y components ["paypal-payments"] (src/web/components.tsx:179)
  [✓] Llama a findEligibleMethods + isEligible("paypal") antes de mostrar el botón (src/web/components.tsx:196-197)
  [✓] session.start recibe una Promise ya creada (no una función) que resuelve a { orderId } (src/web/components.tsx:233-238)
  [✓] Usa data.orderId (no orderID) (src/web/components.tsx:204)

[PAY LATER / VENMO / SUSCRIPCIONES]
  [ℹ] INFO     — No se usan; comprobaciones no aplicables

[WEBHOOKS]
  [✓] Verifica la firma con verify-webhook-signature sobre el cuerpo crudo, sin volver a serializarlo (src/server/paypal.ts:266-284)
  [✓] Idempotencia por event_id, registrada después de verificar (src/server/index.ts:295-298)
  [✓] Solo se registra con HTTPS y con tipos de evento explícitos (src/server/paypal.ts:286-306)
  [ℹ] INFO     — Responde 401 si la firma falla; coincide con la referencia del toolkit (4xx)
  [✗] CRITICAL — PAYMENT.CAPTURE.COMPLETED/DENIED solo se registran; una captura PENDING nunca se resuelve (src/server/index.ts:305, domain.ts:532-536)
  [ℹ] INFO     — El evento queda marcado como procesado antes de que termine finalize(); depende del sweeper si falla (src/server/index.ts:295-306)

[ENTORNO Y CONFIGURACIÓN]
  [✓] Solo usa api-m.sandbox.paypal.com; no hay ninguna URL de producción (src/server/env.ts:23)
  [✓] debug_id se guarda en queue, onError y oauth (src/server/queue.ts:75-77, index.ts:62)
  [✓] 429 con Retry-After o espera de 60 s; 5xx y errores de red se reintentan con el mismo PayPal-Request-Id (src/server/queue.ts:72-75)
  [⚠] WARNING  — Si se agotan los reintentos de una captura (5xx o red), se libera la autorización y se pierde la unidad (src/server/domain.ts:561-584)
  [⚠] WARNING  — Sin protección CSRF en POST /api/drops/:slug/entries, que crea órdenes en PayPal (src/server/index.ts:125)
  [ℹ] INFO     — clientIp() toma el último salto de X-Forwarded-For; sin un proxy delante, el cliente puede falsearlo y saltarse el límite de peticiones (src/server/index.ts:41-44)
  [ℹ] INFO     — Un void sobre una autorización que ya está CAPTURED marca la entrada como "voided, never charged" (src/server/domain.ts:550-552)
  [ℹ] INFO     — Una autorización solo se respeta 3 días; el drop showcase (48 h) cabe, pero un drop de más de 72 h necesitaría reautorizar

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Summary: 2 critical · 5 warnings · 23 passed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  [ℹ] Pruebas en vivo (MCP) omitidas: sesión de solo lectura. Usa /paypal:setup para activarlas.
```

---

## Cambios propuestos

### ✗1 — INSTRUMENT_DECLINED bloquea al comprador (`domain.ts:558`)

**Qué pasa:** el comprador aprueba, pero su método de pago se rechaza al autorizar (422). La entrada pasa a `error` y conserva `payer_hash`. Como el índice único `entries_one_per_payer` solo excluye las entradas `duplicate`, cualquier entrada nueva de esa cuenta se marca como duplicada. Ese comprador no puede volver a participar en el drop.

Además, aunque se volviera a llamar a `finalize`, la clave `auth:${entry.id}` ya está en `ops` (`ON CONFLICT DO NOTHING`), y PayPal devolvería la respuesta guardada para ese PayPal-Request-Id.

**Código actual:**
```ts
if (op.kind === "authorize") {
  updateEntry(e.id, { status: "error", note: `PayPal could not place the hold (${f.issue}).` });
```

**Corrección:** devolver al comprador a la misma orden para que elija otro método de pago (es lo que indica PayPal), y liberar el hueco del pagador en cualquier error terminal.
```ts
if (op.kind === "authorize") {
  if (f.issue === "INSTRUMENT_DECLINED" || f.issue === "PAYER_ACTION_REQUIRED") {
    // the buyer must pick another funding source on the SAME order (PayPal approve link), so reopen the entry
    db.prepare(
      "UPDATE entries SET status = 'awaiting_person', payer_hash = NULL, account_hash = NULL, email_hash = NULL, note = ?, updated_at = ? WHERE id = ? AND status = 'authorizing'",
    ).run("Your payment method was declined — reopen PayPal and choose another one.", now(), e.id);
    emit(e.drop_id, "instrument_declined", `Hold for ${e.public_id} declined (${f.issue}) — person sent back to PayPal.`, true);
    return;
  }
  db.prepare("UPDATE entries SET status = 'error', payer_hash = NULL, note = ?, updated_at = ? WHERE id = ?").run(`PayPal could not place the hold (${f.issue}).`, now(), e.id);
```
Y en `finalize` (`domain.ts:250`), una clave por cada transición, para que el reintento lleve un PayPal-Request-Id nuevo:
```ts
const t = now(); // usar este mismo valor en el UPDATE condicional de arriba
enqueue("authorize", `auth:${entry.id}:${t}`, entry.id);
```
En `/me/:id`, si la entrada vuelve a `awaiting_person` con esa nota, hay que mostrar un enlace a `https://www.sandbox.paypal.com/checkoutnow?token=${order_id}`, o guardar `approveUrl` al crear la orden.

### ✗2 — Capturas PENDING atascadas y webhooks de captura ignorados (`index.ts:305`, `domain.ts:532`)

**Qué pasa:** si `captureAuthorization` devuelve `PENDING`, la operación se marca `done` y la entrada sigue en `won`. El webhook `PAYMENT.CAPTURE.COMPLETED` llega, pero solo emite un log. `settleIfDone` nunca liquida el drop (`unresolvedWinners > 0`), y un `PAYMENT.CAPTURE.DENIED` nunca pasa la unidad a la lista de espera.

**Código actual:**
```ts
if (entry) emit(entry.drop_id, "webhook", `Webhook ${evt.event_type} verified (signature OK) for ${entry.public_id}.`, true);
if (evt.event_type === "CHECKOUT.ORDER.APPROVED" && resId) void finalize(resId).catch(() => undefined);
```

**Corrección**, en `index.ts`:
```ts
if (evt.event_type === "CHECKOUT.ORDER.APPROVED" && resId) void finalize(resId).catch(() => undefined);
if ((evt.event_type === "PAYMENT.CAPTURE.COMPLETED" || evt.event_type === "PAYMENT.CAPTURE.DENIED") && resId)
  void onCaptureEvent(resId, evt.event_type === "PAYMENT.CAPTURE.COMPLETED" ? "COMPLETED" : "DENIED").catch(() => undefined);
```
Y en `domain.ts`:
```ts
/** Resolves captures that PayPal reported as PENDING (webhook is signature-verified). */
export async function onCaptureEvent(captureId: string, status: "COMPLETED" | "DENIED") {
  const e = db.prepare("SELECT * FROM entries WHERE capture_id = ? AND status = 'won'").get(captureId) as EntryRow | undefined;
  if (!e) return;
  const drop = getDrop(e.drop_id)!;
  if (status === "COMPLETED") {
    const ok = db.prepare("UPDATE entries SET status = 'captured', captured_cents = ?, updated_at = ? WHERE id = ? AND status = 'won'").run(captureAmount(drop), now(), e.id);
    if (ok.changes) { emit(drop.id, "captured", `Pending capture for ${e.public_id} completed.`, true); settleIfDone(drop.id); }
  } else {
    const ok = db.prepare("UPDATE entries SET status = 'capture_failed', note = ?, updated_at = ? WHERE id = ? AND status = 'won'").run("Payment denied by PayPal. The unit passes to the waitlist.", now(), e.id);
    if (ok.changes) { emit(drop.id, "capture_failed", `Capture for ${e.public_id} DENIED — promoting waitlist.`, true); await promoteNext(drop.id); }
  }
}
```
Como red de seguridad, para cuando falten webhooks (por ejemplo en localhost), el `sweep()` debería revisar las entradas `won` que tengan `capture_id` usando `payments.getCapturedPayment`.

### ⚠1 — HASH_SECRET con valor por defecto (`env.ts:14`)
```ts
HASH_SECRET: z.string().min(8).default("paylet-dev-secret"),
```
**Corrección:** que sea obligatorio cuando la app está desplegada.
```ts
HASH_SECRET: z.string().min(32).optional(),
// tras parse:
if (!env.HASH_SECRET && env.PUBLIC_URL.startsWith("https://")) throw new Error("HASH_SECRET is required when deployed");
```
Si no, los HMAC de emails y payer IDs se pueden revertir probando un diccionario de emails conocidos.

### ⚠2 — No se mira el estado de la autorización (`domain.ts:510`)
```ts
if (!r.authorizationId) throw new Error(`authorize returned no authorization (status ${r.status})`);
```
**Corrección:**
```ts
if (!r.authorizationId || (r.status !== "CREATED" && r.status !== "PENDING")) throw new Error(`AUTHORIZATION_${r.status || "MISSING"}`);
```
Así una autorización `DENIED` va por `onTerminal` en lugar de entrar al sorteo sin retención real.

### ⚠3 — URLs de retorno en HTTP (`env.ts:11`)
```ts
PUBLIC_URL: z.string().url().default("http://localhost:8790"),
```
**Corrección:**
```ts
PUBLIC_URL: z.string().url().default("http://localhost:8790")
  .refine((u) => u.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u), "PUBLIC_URL must be https outside localhost"),
```

### ⚠4 — Agotar reintentos libera la autorización del ganador (`domain.ts:562`)
Las esperas suman unos 3 minutos (2+4+8+16+32+60+60 s). Una caída del sandbox de ese tiempo hace que `onTerminal` vea la autorización en `CREATED`, encole un void y pase la unidad a la lista de espera, aunque el comprador no hizo nada mal.
```ts
if (f.cls === "CONFIG") {
```
**Corrección:**
```ts
if (f.cls === "CONFIG" || f.cls === "RETRYABLE") {
  // PayPal or our config is down, not the buyer: never burn the waitlist on an outage
```
El mensaje del `emit` habría que generalizarlo en consecuencia.

### ⚠5 — CSRF en la creación de entradas (`index.ts:125`)
Cualquier web externa puede hacer POST a `/api/drops/:slug/entries` y crear órdenes en tu nombre. El impacto es acotado (sandbox y 20 peticiones/min), pero consume el rate limit de PayPal y llena la BD.
```ts
app.post("/api/drops/:slug/entries", async (c) => {
```
**Corrección** (middleware antes de las rutas `/api`):
```ts
const ORIGIN = new URL(env.PUBLIC_URL).origin;
app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET") {
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    if (site === "cross-site" || (origin && origin !== ORIGIN)) return c.json({ error: "cross_site_request" }, 403);
  }
  await next();
});
```
El `csrf()` de Hono solo filtra content-types de formulario, y un `fetch` no-cors sin cuerpo se lo salta; por eso propongo esta versión. En desarrollo, si Vite reenvía la petición con su propio Origin, hay que añadir ese origen a la lista de permitidos. `/mcp` no se ve afectado.

---

**Prioridad:** ✗2 primero (puede dejar un drop sin liquidar en la demo), luego ✗1 y ⚠4. Los otros tres avisos son cambios de una línea.

¿Quieres que lo prepare como un parche (diff) para aplicarlo en el repo original?

---

## 2. `/paypal:explain-error 422 UNPROCESSABLE_ENTITY AUTHORIZATION_VOIDED`

**`AUTHORIZATION_VOIDED` (422)** significa que intentaste capturar una autorización que ya está anulada (`VOIDED`). Es un estado final: esa autorización ya no se puede capturar ni reautorizar. No hay que reintentar. Para cobrar hace falta una autorización u orden nueva que el comprador vuelva a aprobar.

## 1. Qué significa
PayPal liberó los fondos retenidos al anular la autorización. Por eso `POST /v2/payments/authorizations/{id}/capture` responde `422 UNPROCESSABLE_ENTITY` con `details[0].issue = "AUTHORIZATION_VOIDED"`. Repetir la llamada, aunque sea con otro `PayPal-Request-Id`, devolverá siempre el mismo error.

## 2. Causas habituales
- **Una anulación y una captura compiten.** Se programa un void (perdedor, fusión, cierre del drop) y luego una captura de la misma autorización, o al revés.
- **Anulación externa.** Alguien la anuló desde el dashboard de PayPal o desde otro proceso, y tu BD no lo sabe porque el webhook `PAYMENT.AUTHORIZATION.VOIDED` aún no llegó.
- **Prueba negativa intencionada.** Es lo que ocurre en Paylet: `src/server/domain.ts:525-531` anula la autorización a propósito antes de capturarla.

## 3. Cómo arreglarlo
1. **Tratarlo como error final:** nada de reintentar ni de usar backoff.
2. **Confirmar con un GET** (`GET /v2/payments/authorizations/{id}`). Si devuelve `VOIDED`, marca la entrada como fallida, no la anules otra vez y pasa la unidad a la lista de espera.
3. **Evitar la carrera:** antes de encolar una captura, comprueba que la entrada siga en `won` y que no exista una operación `void:{authId}` pendiente. Lo mismo al revés.
4. **Para volver a cobrar**, crea una orden nueva con intent `AUTHORIZE` y pide al comprador que la apruebe.

**Revisión del código de Paylet (solo lectura):** esto ya está bien resuelto.
- `classify()` (`src/server/paypal.ts:70-73`) clasifica el 422 como `TERMINAL`, así que la cola no lo reintenta.
- `onTerminal` (`src/server/domain.ts:568-584`) consulta la autorización con un GET. Como el estado es `VOIDED`, no encola otro void, marca `capture_failed` y ejecuta `promoteNext`.
- `voidAuthorizationSafe` (`src/server/paypal.ts:224`) ya trata `AUTHORIZATION_VOIDED` como "ya anulada".

Solo hay un detalle que corregir: el comentario de `domain.ts:527` dice que es "el mismo camino que sigue una retención caducada o rechazada en producción". No es exacto. Una autorización caducada devuelve otro código (`AUTHORIZATION_EXPIRED`), aunque `onTerminal` lo maneja igual. Propongo cambiarlo por "el mismo camino que sigue una retención que fue liberada antes de cobrarla".

## 4. Ejemplo de código (TypeScript, con el `classify` del proyecto)
```ts
import * as paypal from "./paypal";

export async function captureOrFail(authId: string, cents: number, requestId: string, invoiceId: string) {
  try {
    return { ok: true as const, ...(await paypal.captureAuthorization(authId, cents, requestId, invoiceId)) };
  } catch (err) {
    const f = paypal.classify(err);
    if (f.status === 422 && f.issue === "AUTHORIZATION_VOIDED") {
      // Terminal: no reintentar. Registrar debug_id para soporte.
      console.warn("capture on voided auth", authId, f.debugId);
      return {
        ok: false as const,
        retry: false,
        userMessage: "La retención de tu pago se liberó antes de cobrarse, así que no se te ha cobrado nada. Si quieres el artículo, tendrás que confirmar el pago de nuevo.",
      };
    }
    if (f.cls === "RETRYABLE") throw err; // 429/5xx: la cola reintenta con el MISMO PayPal-Request-Id
    return { ok: false as const, retry: false, userMessage: "No pudimos completar el pago." };
  }
}
```

## 5. Errores relacionados
- `AMOUNT_MISMATCH` (422): es el mismo endpoint de captura, y el importe capturado no cuadra con el autorizado. Ojo con la captura parcial de Paylet (`price + ship_actual`).
- `INSTRUMENT_DECLINED` / `TRANSACTION_REFUSED` (422): también son rechazos finales de la captura y se manejan igual (lista de espera, sin reintento automático).
- `RESOURCE_NOT_FOUND` (404): el ID de autorización no existe o pertenece a otra cuenta.
- `INTERNAL_SERVER_ERROR` (500): este sí se reintenta, con el mismo `PayPal-Request-Id`.

Si contactas con el soporte de PayPal (https://developer.paypal.com/support/), adjunta el cuerpo completo de la respuesta y el `debug_id`. El proyecto ya lo guarda en `ops.last_error` (`src/server/queue.ts:77`).

---

## 3. `/paypal:explain-error 429 RATE_LIMIT_REACHED`

**`429 RATE_LIMIT_REACHED`**: PayPal está frenando tus llamadas porque mandas demasiadas en poco tiempo. Hay que esperar y reintentar con la **misma** `PayPal-Request-Id`. Tu código ya lo trata como reintentable, pero tiene tres huecos que explico en el punto 3.

## 1. Qué significa
PayPal rechazó la petición antes de procesarla. La autorización, captura o anulación **no se ejecutó**, así que reintentar con la misma clave de idempotencia es seguro. En sandbox los límites son más estrictos y menos predecibles que en producción. PayPal no publica cifras fijas, así que no conviene ajustar el ritmo a un número concreto.

## 2. Causas habituales
- **Ráfagas:** al cerrar un drop salen muchas capturas y anulaciones a la vez.
- **Ráfaga al arrancar:** tu token bucket empieza lleno (`tokens = PER_MINUTE`, `queue.ts:33`), así que tras un reinicio pueden salir 40 llamadas de golpe.
- **Seguir enviando tras un 429:** cuando una op recibe 429, solo esa se aplaza. El resto de la cola sigue a 40/min y probablemente choque con el mismo límite.
- **Reintentos sincronizados:** el backoff no tiene jitter (aleatoriedad), así que las ops que fallan juntas reintentan juntas.
- **Token OAuth:** también puede recibir 429 si se pide un token nuevo con demasiada frecuencia.

## 3. Cómo arreglarlo: revisión de tu código
Lo que ya está bien:
- `classify()` marca 429 como `RETRYABLE` y lee `Retry-After` (`paypal.ts:69-79`).
- Los reintentos del SDK están desactivados y los gestiona la cola persistente (`paypal.ts:26`).
- La clave de la op se reutiliza como `PayPal-Request-Id`, así que un reintento no puede cobrar dos veces.
- Se guarda `debug_id` en `last_error`.

Huecos, por orden de importancia:
1. **Un 429 se acaba convirtiendo en fallo definitivo** (`queue.ts:72`). Tras 8 intentos (unos 8 minutos de 429 seguidos con el fallback de 60 s), la op pasa a `failed` y se ejecuta `onTerminal`. En una **captura** eso significa perder una venta por un problema que solo era de ritmo. Los 429 no deberían contar contra el límite de 8, o deberían tener uno mucho mayor.
2. **Falta una pausa global:** un 429 debería frenar toda la cola, no solo esa op.
3. **Falta jitter** en el backoff.

Detalle menor: si `Retry-After` llega en formato fecha HTTP, `Number()` da `NaN` y se usa el fallback de 60 s. Es aceptable.

## 4. Código propuesto (TypeScript, `src/server/queue.ts`)
Es una propuesta en texto; no he modificado ningún archivo (la sesión es de solo lectura).

```ts
let pausedUntil = 0; // pausa global tras un 429

export async function tick(h: Handlers): Promise<boolean> {
  if (running || Date.now() < pausedUntil) return false;
  // ...igual que ahora...
  } catch (e) {
    const f = classify(e);
    const attempts = op.attempts + 1;
    const rateLimited = f.status === 429;
    // un 429 no es un fallo del pago: no lo cuentes contra el límite de intentos
    const retry = rateLimited || ((f.cls === "RETRYABLE" || f.cls === "WAIT") && attempts < 8);
    if (retry) {
      const base = f.retryAfterMs ?? (rateLimited ? 60_000 : Math.min(60_000, 1000 * 2 ** attempts));
      const backoff = Math.round(base * (0.8 + Math.random() * 0.4)); // jitter ±20 %
      if (rateLimited) {
        pausedUntil = Date.now() + backoff; // frena toda la cola, no solo esta op
        tokens = 0;                          // y vacía el bucket para no salir en ráfaga
      }
      db.prepare("UPDATE ops SET next_at = ?, last_error = ?, updated_at = ? WHERE key = ?")
        .run(now() + backoff, `${f.status} ${f.issue} debug=${f.debugId ?? "-"}`, now(), op.key);
    } else { /* ...terminal, igual que ahora... */ }
  }
```

Dos cambios más:
- **Arranque sin ráfaga:** cambiar `let tokens = PER_MINUTE;` por `let tokens = 1;` (o un valor pequeño).
- **Por seguridad:** si quieres un tope incluso para los 429, que sea por tiempo y no por intentos, por ejemplo abandonar solo si la op lleva más de N horas pendiente. Una autorización sigue siendo capturable durante días, así que no hay prisa por abandonarla.

**Mensaje al usuario:** como la op ya está en la cola persistente, el usuario no ve un error. Basta con un estado neutro, por ejemplo: *"Estamos confirmando tu pago con PayPal; tu reserva está guardada. Puede tardar unos minutos."* Nunca hay que pedirle que repita el pago.

## 5. Errores relacionados
- `INTERNAL_SERVER_ERROR` (500): sigue el mismo camino de reintento con la misma `PayPal-Request-Id`; registra el `debug_id`.
- `DUPLICATE_TRANSACTION` (409): puede salir al reintentar si la llamada original sí se procesó; recupera el recurso que ya existe.
- `UNAUTHORIZED` (401): el token OAuth también puede recibir 429 o caducar entre reintentos largos; renuévalo con `POST /v1/oauth2/token`.

Si el problema persiste, abre un caso en https://developer.paypal.com/support/ con el cuerpo completo de la respuesta y el `debug_id` (ya los guardas en `ops.last_error`).
