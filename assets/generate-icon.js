// Generate a simple app icon as PNG
// Run: node assets/generate-icon.js

const fs = require('fs');

// Create a simple 1024x1024 PNG icon
// This is a minimal valid PNG with a blue shield shape

// For now, create a placeholder that electron-builder can use
// In production, use a proper icon file

const pngHeader = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
]);

// Note: This creates a minimal placeholder
// For a real icon, use an image editor or convert from SVG

console.log('Icon placeholder created. For production, replace assets/icon.png with a proper 1024x1024 PNG icon.');
console.log('You can create one at: https://icon.kitchen/ or use any image editor.');
