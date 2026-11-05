# PrintNomad privacy policy

Last updated: November 4, 2026. [Versión en español](#política-de-privacidad-de-printnomad).

PrintNomad is a browser extension that converts 3MF 3D-printing projects for your printer and slicer.
**The conversion runs entirely in your browser, and your 3MF files are never uploaded.** There are
no accounts, ads or analytics, and we do not sell your data.

## What stays on your device

- **Your settings:** your printers and conversion preferences are kept in Chrome's extension storage
  (`chrome.storage.sync`). If you have turned on Chrome sync, Google syncs them across your devices.
- **Your files:** the projects you convert are processed in memory and saved through Chrome's
  downloads, like any other download.

## What PrintNomad does on MakerWorld

The extension runs only on `makerworld.com` and `makerworld.com.cn`. It adds your printers and a
Save button to model pages. When you click that button, it reads the download you asked for and
converts it in your browser. It does not read your MakerWorld account or send your browsing to us.

## Reports you choose to send

If a conversion fails, you can send us a report. Nothing is sent until you click **Send report**, and
you can open **What is sent** first to read the report text.

A report contains:

- the extension version, printer, slicer and build plate;
- the name of the file, or the MakerWorld page path if the page itself caused the error;
- your browser's user agent;
- the conversion's result, including its settings and errors;
- a comment and an email address, only if you add them.

The 3MF file is never included.

If you ask us to support a printer with **Ask for it**, we receive the printer name you typed and the
extension version, by the same route.

We use reports only to fix problems and, if you left an email address, to reply to you.

- **Cloudflare** runs the service that receives reports. It uses your IP address to limit how many
  reports can be sent per minute. Our service does not store that address or add it to the report.
- **GitHub** stores each report as an issue in a private repository that only the PrintNomad
  maintainers can read. If a report shows a problem worth tracking in public, we copy it to the public
  repository without your email address.

We keep reports while they help us fix the problem they describe. To have a report deleted, write to
us at the address below.

## Other network requests

PrintNomad downloads the 3MF file from MakerWorld's servers when you click its button on MakerWorld.
Its printer profiles are included in the extension, so it needs no other connection.

## Changes and contact

If this policy changes, we will update it here and change the date above.

Questions or deletion requests: CONTACT_EMAIL. Source code:
<https://github.com/printnomad/printnomad>

---

# Política de privacidad de PrintNomad

Última actualización: 4 de noviembre de 2026.

PrintNomad es una extensión de navegador que convierte proyectos 3MF de impresión 3D para tu impresora
y tu laminador. **La conversión ocurre por completo en tu navegador y tus archivos 3MF nunca se suben.**
No hay cuentas, anuncios ni analítica, y no vendemos tus datos.

## Lo que se queda en tu dispositivo

- **Tus ajustes:** tus impresoras y preferencias de conversión se guardan en el almacenamiento de
  extensiones de Chrome (`chrome.storage.sync`). Si tienes activada la sincronización de Chrome, Google
  los sincroniza entre tus dispositivos.
- **Tus archivos:** los proyectos que conviertes se procesan en memoria y se guardan mediante las
  descargas de Chrome, como cualquier otra descarga.

## Lo que hace PrintNomad en MakerWorld

La extensión solo se ejecuta en `makerworld.com` y `makerworld.com.cn`. Añade tus impresoras y un botón
de guardar en las páginas de los modelos. Cuando pulsas ese botón, lee la descarga que pediste y la
convierte en tu navegador. No lee tu cuenta de MakerWorld ni nos envía tu navegación.

## Los reportes que decides enviar

Si una conversión falla, puedes enviarnos un reporte. No se envía nada hasta que pulsas **Enviar
reporte**, y antes puedes abrir **Qué se envía** para leer el texto del reporte.

Un reporte contiene:

- la versión de la extensión, la impresora, el laminador y la placa;
- el nombre del archivo, o la ruta de la página de MakerWorld si el error lo causó la propia página;
- el agente de usuario de tu navegador;
- el resultado de la conversión, con sus ajustes y errores;
- un comentario y un email, solo si los añades.

El archivo 3MF nunca se incluye.

Si nos pides soporte para una impresora con **Pedirla**, recibimos el nombre que escribiste y la versión
de la extensión, por la misma vía.

Usamos los reportes solo para corregir problemas y, si dejaste un email, para responderte.

- **Cloudflare** opera el servicio que recibe los reportes. Usa tu dirección IP para limitar cuántos
  reportes se pueden enviar por minuto. Nuestro servicio no guarda esa dirección ni la añade al reporte.
- **GitHub** guarda cada reporte como una incidencia en un repositorio privado que solo pueden leer
  quienes mantienen PrintNomad. Si un reporte muestra un problema que conviene seguir en público, lo
  copiamos al repositorio público sin tu email.

Conservamos los reportes mientras ayuden a corregir el problema que describen. Para pedir que borremos
un reporte, escríbenos a la dirección de abajo.

## Otras conexiones

PrintNomad descarga el archivo 3MF de los servidores de MakerWorld cuando pulsas su botón en MakerWorld.
Los perfiles de impresoras vienen incluidos en la extensión, así que no necesita ninguna otra conexión.

## Cambios y contacto

Si esta política cambia, la actualizaremos aquí y cambiaremos la fecha de arriba.

Preguntas o solicitudes de borrado: CONTACT_EMAIL. Código fuente:
<https://github.com/printnomad/printnomad>
