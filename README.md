# Escáner DECOM

App Android para escanear documentos con la cámara, al estilo CamScanner. Funciona sin internet.

- **Escanear**: abre la cámara del teléfono, detecta la hoja y endereza la perspectiva.
- **Ajustar bordes**: arrastra las esquinas (con lupa) o los bordes; botón "Toda la foto" y giro.
- **Mejorar**: filtros *Mejorado* (quita sombras, papel blanco, tinta viva), *Blanco y negro*, *Grises* y *Original*. La app recuerda el último filtro usado.
- **Documentos de varias páginas**: agrega, reordena, gira, reajusta o elimina páginas. Todo queda guardado en la app.
- **Importar**: varias fotos de la galería a la vez, o compártelas hacia la app desde la galería.
- **Exportar**: PDF a *Descargas › Escaner DECOM*, imágenes JPG a la *Galería › Escaner DECOM*, o compartir PDF / imágenes (WhatsApp, correo, Drive…).

Requiere Android 10 o superior.

## Generar el APK

Igual que Lector Docs: sube esta carpeta a un repositorio de GitHub y crea el archivo
`.github/workflows/build-apk.yml` (incluido aquí como referencia). En **Actions** descarga el
artefacto **EscanerDECOM-apk**.

O en Android Studio: *Build → Build APK(s)*.

## Estructura

| Ruta | Qué contiene |
|---|---|
| `app/src/main/java/.../MainActivity.java` | Cámara, galería, guardar en Descargas/Galería, compartir |
| `app/src/main/assets/www/scan.js` | Detección de la hoja, perspectiva y filtros |
| `app/src/main/assets/www/app.js` | Pantallas: inicio, recorte, mejora, documento, exportar |
| `app/src/main/assets/www/store.js` | Documentos guardados en el teléfono |
| `app/src/main/assets/www/lib/` | pdf-lib (licencia incluida) |

## Limitaciones

- La detección automática funciona mejor con la hoja sobre un fondo más oscuro que ella. Sobre mesas claras o con sombras fuertes encima de una esquina, puede que haya que ajustar esa esquina a mano.
- Los documentos guardados viven dentro de la app: si se desinstala, se borran (los PDF e imágenes exportados sí quedan en el teléfono).
