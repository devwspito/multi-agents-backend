import multer from 'multer';

// Configure multer to use MEMORY storage (not disk)
// Files will be uploaded to Firebase Storage in the route handler
const storage = multer.memoryStorage();

// File filter - only allow images
const fileFilter = (_req: any, file: any, cb: any) => {
  const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type. Only images are allowed (jpg, png, gif, webp). Received: ${file.mimetype}`), false);
  }
};

// Configure multer
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
  },
});

// Single image upload middleware
export const uploadSingleImage = upload.single('image');

// Multiple images upload middleware (max 10 images)
export const uploadMultipleImages = upload.array('images', 10);
