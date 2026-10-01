# belkafut

Canales de deportes para la app (listas en `data.json`, `data1.json`, `data2.json`).

## Automatizaciones

| Workflow | Qué hace | Frecuencia |
| --- | --- | --- |
| `.github/workflows/verify-urls.yml` | **Verifica las URLs de `data1.json` y arregla las caídas** (proveedores conocidos, opciones hermanas y búsqueda web). Deja reporte y avisa por issue. | cada 6 h |
| `.github/workflows/main.yml` | Actualiza los dominios `embed.*` cuando el sitio rota de dominio. | cada 6 h |
| `.github/workflows/update-canales.yml` | Scrapea canales desde las fuentes. | cada 6 h |
| `.github/workflows/test.yml` | Pruebas del verificador en cada push. | push/PR |

Ver **[VERIFY-URLS.md](VERIFY-URLS.md)** para la documentación del verificador.

```bash
node verify-urls.mjs                 # simulación: solo informa
node verify-urls.mjs --apply --search # aplica arreglos verificados
node test/verify-urls.test.mjs        # pruebas (servidor simulado local)
```
