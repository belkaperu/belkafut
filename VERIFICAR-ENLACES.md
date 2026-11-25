# verificar-enlaces.mjs

Comprueba de verdad los enlaces de `data_unificado.json` y borra **solo** los
que no sirven.

## Por qué no basta con mirar el status

Las `options` del catálogo no son enlaces: son **capas de reproductor**.

```
/p/foxrepro1.html?r=https://belkaperu.github.io/belkafut/repron.html
                     ?r=https://belkaperu.github.io/belkafut/repro.html
                     ?r=aHR0cHM6Ly9sYTE4aGQuc3Uv…
```

Comprobar `/p/foxrepro1.html` siempre da 404 (esa ruta no existe en el repo) y
no dice nada del canal. Lo que importa es el **destino real**:

```
https://la18hd.su/vivo/canales.php?stream=espn
```

El script atraviesa las capas (parámetros `r`, `embed`, `u`, `url` y base64) y
comprueba ese destino. Reparto actual de las 237 `options`:

| Capas | Enlaces |
| --- | --- |
| 0 (directas) | 21 |
| 1 | 6 |
| 2 | 166 |
| 3 | 44 |

Los destinos reales se concentran en pocos hosts: `streamxhd.com` (127),
`la18hd.su` (58), `tvf90.com` (21), `embed.saohgdasregions.fun` (14).

## Qué considera "muerto"

Un enlace se borra **solo si se cumplen las tres**:

1. el destino real no responde con contenido útil, **y**
2. falla en **dos pasadas** separadas (un corte pasajero no cuenta), **y**
3. el canal **conserva otro enlace vivo**.

### Se consideran caídos

| Caso | Ejemplo |
| --- | --- |
| 404 / 410 / 5xx | `HTTP 404` |
| DNS inexistente | `ENOTFOUND` |
| Puerto cerrado | `ECONNREFUSED` |
| Timeout tras reintentos | `timeout` |
| 200 con cuerpo vacío | `VACIO` |
| 200 con página de error o dominio en venta | `VACIO` |
| `.m3u8` que no empieza por `#EXTM3U` | `VACIO` |

### NO se consideran caídos

- **401, 403, 405, 418, 429, 503, 520-524** → `BLOQUEO`. Un panel que nos
  rechaza a nosotros no está muerto para el navegador.
- **Cualquier enlace protegido** por ser el último del canal.
- **Enlaces sin veredicto** (si algo interrumpe la comprobación, no se tocan).

## Por qué nunca se borra por host

En el catálogo actual:

| Host | Fallos | En el archivo | Veredicto |
| --- | --- | --- | --- |
| `belami.top` | 282 | 282 | **caído** |
| `181.188.216.5:18000` | 107 | 107 | **caído** |
| `45.228.234.30:16000` | 11 | 146 | **vivo** |
| `200.10.30.241:8000` | 2 | 97 | **vivo** |

Borrar "los hosts que fallan" se llevaría por delante 243 enlaces buenos. Por eso
el borrado es **enlace por enlace**, y el informe solo señala qué hosts fallan
en el 100 % de sus enlaces.

## Uso

```bash
node verificar-enlaces.mjs                  # simulación: informe por pantalla
node verificar-enlaces.mjs --apply          # borra los confirmados muertos
node verificar-enlaces.mjs --solo-options   # comprobar solo las options
node verificar-enlaces.mjs --reporte=r.json # informe en JSON
```

| Opción | Por defecto | Para qué |
| --- | --- | --- |
| `--archivo=` | `data_unificado.json` | archivo a revisar |
| `--timeout=` | `10000` | ms por petición |
| `--concurrencia=` | `4` | peticiones simultáneas **por host** |
| `--pausa=` | `250` | ms entre peticiones al mismo host |
| `--reintentos=` | `2` | intentos por enlace dentro de una pasada |
| `--pasadas=` | `2` | pasadas separadas para confirmar |
| `--espera-pasada=` | `2000` | ms entre pasadas |
| `--max-caido=` | `0.9` | si cae más que esto, aborta |
| `--solo-options` | — | ignora `servers` |

## Salvaguardas

1. **Canario de red**: antes de empezar prueba `example.com` y
   `google.com/generate_204`. Si no hay internet, **aborta con código 2** en vez
   de declarar muerto todo el catálogo. Saltar con `--sin-canario`.
2. **Tope de caídos**: si más del 90 % sale mal, aborta (`--max-caido=1` lo
   desactiva).
3. **Nunca deja un canal vacío**: el último enlace se conserva aunque falle.
4. **Pausa por host**: `HostGate` limita la concurrencia y espacia las
   peticiones, para no provocar el propio bloqueo que luego se lee como caída.

## GitHub Actions

`.github/workflows/verificar-enlaces.yml` (ejecución manual):

- **apply** desactivado → solo informa y sube `verificacion-enlaces.json`.
- **apply** activado → borra, y si `data_unificado.json` cambia, hace commit y
  push. El nuevo JSON entra en el siguiente `build-unificado.mjs` como fuente.

El runner de GitHub sí tiene internet, que es lo que falta en entornos aislados.

## Esquema intacto

El borrado solo quita elementos de `servers` y `options`. La raíz sigue siendo
`{categories, channels}` y cada canal conserva sus 7 campos. Las pruebas lo
verifican explícitamente (`test/verificar-enlaces.test.mjs`), así que un borrado
no puede cambiar la estructura.
