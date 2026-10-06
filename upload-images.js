const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');

cloudinary.config({
  cloud_name: 'iobtqc2g',
  api_key: '175498488934745',
  api_secret: 'FDC-_1qDMCKRp-JswrOmku37HaQ'
});

const uploadDir = 'C:\\Users\\sjsam\\Downloads\\jayrajput';
const files = fs.readdirSync(uploadDir).filter(f => f.endsWith('.jpeg') || f.endsWith('.jpg') || f.endsWith('.JPG') || f.endsWith('.JPEG'));

async function uploadAll() {
  console.log(`Found ${files.length} images to upload...`);
  
  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(uploadDir, files[i]);
    const publicId = `jayrajputmedia/services/${path.basename(files[i], path.extname(files[i]))}`;
    
    try {
      console.log(`[${i + 1}/${files.length}] Uploading ${files[i]}...`);
      const result = await cloudinary.uploader.upload(filePath, {
        folder: 'jayrajputmedia/services',
        public_id: publicId,
        resource_type: 'image',
        transformation: [
          { width: 800, height: 600, crop: 'limit', quality: 'auto' },
          { fetch_format: 'auto' }
        ]
      });
      console.log(`  ✓ Uploaded: ${result.secure_url}`);
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
    }
  }
  
  console.log('\nUpload complete!');
}

uploadAll();
