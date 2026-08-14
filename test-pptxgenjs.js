const PptxGenJS = require('pptxgenjs');
const fs = require('fs');

async function test() {
  console.log('Testing pptxgenjs nodebuffer...');
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'TEST', width: 10, height: 6.5 });
  pptx.layout = 'TEST';

  const slide = pptx.addSlide();
  slide.addText('Hello World', { x: 1, y: 1, w: 5, h: 1 });

  console.log('Calling pptx.write nodebuffer...');
  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  console.log('Buffer received! Length:', buffer ? buffer.length : 0);

  fs.writeFileSync('test-nodebuffer.pptx', buffer);
  console.log('Saved test-nodebuffer.pptx!');
}

test().catch(err => console.error('Error:', err));
