Denying Bash also turns off the PowerShell tool, so Claude has neither. To use PowerShell, set CLAUDE_CODE_USE_POWERSHELL_TOOL=1.
# Revisión de la integración de PayPal (`@paypal/paypal-server-sdk` 2.5.0)

Hay 11 desviaciones respecto a las skills. Las más graves son tres:
- **Errores no-`ApiError` se reintentan:** cualquier error que no sea `ApiError` se clasifica como `RETRYABLE`, así que bugs y fallos de configuración se reintentan 8 veces.
- **Un timeout que no lo cubre todo:** una llamada colgada puede bloquear toda la cola, porque el timeout no cubre la obtención del token.
- **Dos tokens OAuth:** tenéis una caché de token propia que duplica la que ya trae el SDK.

Solo he leído `src/server/paypal.ts` y `src/server/queue.ts`. No he abierto `.env` ni el código fuente del SDK, así que los nombres internos del SDK que menciono hay que comprobarlos (los marco con ⚠).

## 1. Skills cargadas
- [x] `paypal:typescript-getting-started`
- [x] `paypal:typescript-error-handling`
- [x] `paypal:typescript-configuration-resilience`
- [x] `paypal:typescript-calling-endpoints`
- [ ] `paypal:typescript-testing` no se pidió ni se cargó. Lo que digo sobre respuestas mock se basa en la skill de configuración.

## 2. Desviaciones y cómo corregirlas

**Errores (`ApiError`, `result` frente a `body`)**
- [ ] **`paypal.ts:63-64`: todo lo que no es `ApiError` se clasifica como `NETWORK`/`RETRYABLE`.** La skill pide tratar por separado cuatro casos: errores de red de axios, `AbortError`, el `Error` simple que lanza el SDK cuando faltan credenciales ("Required authentication credentials…") y los bugs propios (`TypeError`). Ahora mismo una configuración rota o un bug se reintenta 8 veces.
  - **Corrección:** `AbortError` o `isAxiosError` con un `code` de red → `RETRYABLE`; un mensaje que empiece por "Required authentication credentials" → `CONFIG`; el resto → `TERMINAL`.
- [ ] **`paypal.ts:120`: `result.id!`.** Si la respuesta llega sin `id`, el `TypeError` acaba en el caso anterior y se reintenta.
  - **Corrección:** `if (!result.id) throw new Error("createOrder: missing id")` y clasificar ese error como `TERMINAL`.
- [ ] **`paypal.ts:46`: se usa `(e as any).result`.** El orden `result` → `body` es correcto, pero el `any` hace que se pierda el tipo.
  - **Corrección:** tipar `body` como `{ name?: string; message?: string; debug_id?: string; details?: { issue?: string; description?: string }[] }`. Mantener los nombres en snake_case, porque las respuestas de error no se pasan a camelCase.
  - No usar `instanceof` con subclases tipadas sin comprobar antes `typeof sdk.XError === "function"`, por el riesgo de que un modelo con el mismo nombre las tape.
- [ ] **`paypal.ts:47`: solo se parsea `body` cuando es un `string`.** `body` también puede ser `Blob` o `ReadableStream`, y en ese caso `issue` queda como `"UNKNOWN"`.
  - **Corrección:** registrar que el formato no se reconoce, en lugar de dar `{}` en silencio.

**Request ids y depuración**
- [ ] **`paypal.ts:61`: `debugId` solo se lee del cuerpo.**
  - **Corrección:** usar como alternativa la cabecera `e.headers["paypal-debug-id"]` y buscarla sin distinguir mayúsculas.
- [ ] **`queue.ts:64,66`: `last_error` no guarda el `debugId`, que es lo que pide el soporte de PayPal.**
  - **Corrección:** `` `${f.status} ${f.issue} debug=${f.debugId ?? "-"}` ``.
- [ ] **`queue.ts:63`: ante un 429 se espera siempre 60 s y se ignora `Retry-After`.**
  - **Corrección:** que `classify` devuelva `retryAfterMs` a partir de `e.headers["retry-after"]` y que la cola lo use.

**Timeouts y cancelación**
- [ ] **`paypal.ts:82, 135, 154, 162, 167, 188`: ninguna llamada pasa `requestOptions.abortSignal`.** `timeout: 30_000` se aplica a cada intento y no cubre la obtención del token OAuth, así que una llamada puede tardar hasta unos 60 s o más. Como `queue.ts:53` usa un único `running`, una llamada colgada bloquea toda la cola.
  - **Corrección:** como segundo argumento (forma B), `orders.createOrder({...}, { abortSignal: AbortSignal.timeout(45_000) })`.
  - Además, en `queue.ts:56`, competir `h.run(op)` contra un plazo propio (`Promise.race`), porque la señal tampoco llega a la obtención del token.

**Autenticación y caché del token**
- [ ] **`paypal.ts:199-215`: caché OAuth propia, paralela a la del SDK.** El resultado son dos tokens, dos sitios que leen las credenciales y ninguna deduplicación cuando hay peticiones a la vez: varias llamadas `fetch` simultáneas piden cada una su token. Además, el `throw` de `:211` descarta el cuerpo y el `debug_id`.
  - **Corrección:** reutilizar el gestor OAuth del cliente. ⚠ Buscar `public .*Manager` en `src/client.ts` para encontrar su nombre real.
  - Si se queda la versión propia, guardar la promesa en curso (`let inflight: Promise<string> | undefined`) e incluir `res.status` y `debug_id` en el error.

**Entorno y respuestas mock**
- [ ] **`paypal.ts:24` frente a `:16`: la URL base se define dos veces.** El SDK usa `Environment.Sandbox` fijo y la parte REST usa `PAYPAL_API_BASE`. Si un test o un mock apunta `PAYPAL_API_BASE` a otro host, el SDK sigue llamando al sandbox real con credenciales reales.
  - **Corrección:** comprobar al arrancar que `PAYPAL_API_BASE === "https://api-m.sandbox.paypal.com"`.
  - Para los mocks, usar proxy o DNS. Si se usa un interceptor (`getRequestBuilderFactory().interceptRequest`), hay que reasignar el gestor de autenticación del cliente después de construirlo, porque si no el token se sigue pidiendo al proveedor real. Añadir un test que lo compruebe.
- [ ] **`paypal.ts:19-30`: el cliente es un singleton que se crea al importar el módulo, así que no se puede inyectar un doble en los tests.**
  - **Corrección:** `export function createPayPal(client = new Client({...}))`, o un setter solo para tests.

**Logging y datos personales**
- [ ] **`paypal.ts:27`: falta `logHeaders: false` en `logRequest` y no hay `maskSensitiveHeaders`.** Pasar cualquier objeto `logging` activa `ConsoleLogger`, y `Authorization: Bearer …` y `PayPal-Request-Id` podrían acabar en la consola.
  - **Corrección:** `logging: { logLevel: LogLevel.Warn, maskSensitiveHeaders: true, logRequest: { logBody: false, logHeaders: false }, logResponse: { logBody: false, logHeaders: false }, logger: <tu logger estructurado> }`. ⚠ Comprobar los valores por defecto en `DEFAULT_LOGGING_OPTIONS`.

**Menor (REST propio, fuera del SDK)**
- [ ] **`paypal.ts:225, 261-268`:**
  - **Problemas:**
    - `rest()` no mira `status`: un 401 en el listado de `ensureWebhook` acaba intentando crear el webhook.
    - `JSON.parse` lanza un error si el cuerpo no es JSON.
    - No se captura `paypal-debug-id`.
  - **Corrección:** `if (status >= 400) throw` con el `issue` y el `debug_id`.

## 3. Lo que ya está bien
- [x] `new Client({...})` con `clientCredentialsAuthCredentials` como objeto anidado y los controladores instanciados a mano (`new OrdersController(client)`).
- [x] `timeout: 30_000` explícito. Evita el `0` por defecto, que significa "sin timeout".
- [x] `retryConfig.maxNumberOfRetries: 0`, porque los reintentos los hace la cola. Así se evitan reintentos en dos capas que se multiplican.
- [x] Llamadas con forma B (objeto de opciones), uso de los enums del SDK en lugar de strings, y lectura de `response.result`.
- [x] `classify`: comprueba `instanceof ApiError`, lee `result` y, si no hay, parsea `body`; usa los nombres de error en snake_case (`debug_id`, `details[].issue`); y clasifica 401/403 como `CONFIG` y 429/5xx como `RETRYABLE`.
- [x] `PayPal-Request-Id` estable en create, authorize, capture y void, de modo que reintentar no cobra dos veces.
- [x] `voidAuthorizationSafe` consulta el estado antes y trata `PREVIOUSLY_VOIDED` como éxito.
- [x] `logBody: false` en peticiones y respuestas. Los datos personales de `getOrderIdentity` no salen en los logs del SDK.
- [x] Las llamadas `fetch` a mano tienen `AbortSignal.timeout(...)`.
- [x] La cola limita las peticiones con un token bucket, usa backoff exponencial con tope y no reintenta los errores `TERMINAL` ni `CONFIG`.

No he editado ningún archivo.
