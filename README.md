# belkafut

Canales de deportes para la app (listas en `data.json`, `data1.json`, `data2.json`).

## Automatizaciones

| Workflow | Qué hace | Frecuencia |
| --- | --- | --- |
| `.github/workflows/verify-urls.yml` | Verifica las URLs de `data1.json` (status **+ contenido**) y **arregla las caídas buscando en internet**: Google → agenda de futbollibre → URL real del stream → verificación. Deja reporte y avisa por issue. | cada 6 h (:30) |
| `.github/workflows/update-canales.yml` | **Agrega opciones nuevas** desde la agenda/páginas de canal de futbollibre, solo si la URL verifica. | cada 6 h (:15) |
| `.github/workflows/main.yml` | Actualiza los dominios `embed.*` cuando el sitio rota de dominio. | cada 6 h (:00) |
| `.github/workflows/test.yml` | Pruebas de los scripts en cada push (servidor simulado local). | push/PR |

Ver **[VERIFY-URLS.md](VERIFY-URLS.md)** para la documentación completa.

```bash
node verify-urls.mjs                  # simulación: informa y propone arreglos
node verify-urls.mjs --apply          # arregla las caídas (agenda + Google + proveedores)
node update-canales.mjs               # simulación: canales nuevos desde futbollibre
node update-canales.mjs --apply       # los agrega a data1.json
node test/verify-urls.test.mjs        # pruebas (75 casos, servidor simulado local)
```

Sin dependencias: todo funciona con Node 20+ (`npm install` solo hace falta para
los scripts viejos con axios/cheerio).

## Cómo encuentra las URLs reales

1. Busca `futbollibre` en Google (Bing y DuckDuckGo de respaldo) y detecta el dominio vivo.
2. Entra a la portada y a `/agenda`: los enlaces `/embed/eventos.html?r=<base64>`
   llevan la URL real del stream en base64.
3. Entra a `/en-vivo/<canal>`, donde suele haber un espejo más fresco del reproductor.
4. Verifica cada candidata (HTTP + contenido) y solo entonces la usa.
