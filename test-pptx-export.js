const fs = require('fs');
const path = require('path');
const { app } = require('electron');

app.on('ready', async () => {
  console.log('App is ready! Testing PPTX export pipeline with 2.html...');
  try {
    const htmlPath = path.join(__dirname, '2.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    const { exportPptxFromHtml } = require('./src/pptxExporter');
    const outputPath = path.join(__dirname, 'test-output.pptx');

    const res = await exportPptxFromHtml(html, { widthPx: 950, heightPx: 650 }, outputPath);
    console.log('Export result:', res);

    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      console.log(`SUCCESS! PPTX generated at ${outputPath} (${stats.size} bytes)`);
    } else {
      console.error('FAILED: Output PPTX file does not exist');
    }
  } catch (err) {
    console.error('ERROR IN TEST HANDLER:', err);
  } finally {
    app.quit();
  }
});
