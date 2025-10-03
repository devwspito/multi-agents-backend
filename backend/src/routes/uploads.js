const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const router = express.Router();
const { authenticate, protectData } = require('../middleware/auth');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads');
    
    // Create uploads directory if it doesn't exist
    try {
      await fs.access(uploadDir);
    } catch (error) {
      await fs.mkdir(uploadDir, { recursive: true });
    }
    
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    const filename = `${name}-${uniqueSuffix}${ext}`;
    
    cb(null, filename);
  }
});

// File filter for security
const fileFilter = (req, file, cb) => {
  const allowedTypes = {
    // Images
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg', 
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    
    // Documents
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    
    // Design files
    'application/json': '.json', // For design tokens, etc.
    
    // Archives
    'application/zip': '.zip',
    'application/x-zip-compressed': '.zip'
  };

  if (allowedTypes[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} not allowed. Allowed types: ${Object.keys(allowedTypes).join(', ')}`), false);
  }
};

// Configure multer
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 5 // Maximum 5 files per request
  }
});

/**
 * Upload single file
 */
router.post('/single', authenticate, protectData, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded',
        code: 'NO_FILE',
        field: 'file'
      });
    }

    const fileData = {
      id: req.file.filename,
      originalName: req.file.originalname,
      filename: req.file.filename,
      mimetype: req.file.mimetype,
      size: req.file.size,
      url: `/api/uploads/files/${req.file.filename}`,
      uploadedBy: req.user._id,
      uploadedAt: new Date().toISOString()
    };

    res.status(201).json({
      success: true,
      data: fileData
    });

  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload file',
      code: 'UPLOAD_ERROR',
      details: error.message
    });
  }
});

/**
 * Upload multiple files
 */
router.post('/multiple', authenticate, protectData, upload.array('files', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No files uploaded',
        code: 'NO_FILES',
        field: 'files'
      });
    }

    const filesData = req.files.map(file => ({
      id: file.filename,
      originalName: file.originalname,
      filename: file.filename,
      mimetype: file.mimetype,
      size: file.size,
      url: `/api/uploads/files/${file.filename}`,
      uploadedBy: req.user._id,
      uploadedAt: new Date().toISOString()
    }));

    res.status(201).json({
      success: true,
      data: {
        files: filesData,
        count: filesData.length
      }
    });

  } catch (error) {
    console.error('Error uploading files:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload files',
      code: 'UPLOAD_ERROR',
      details: error.message
    });
  }
});

/**
 * Serve uploaded files
 */
router.get('/files/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(__dirname, '../../uploads', filename);

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch (error) {
      return res.status(404).json({
        success: false,
        message: 'File not found',
        code: 'FILE_NOT_FOUND'
      });
    }

    // Get file stats for headers
    const stats = await fs.stat(filePath);
    const ext = path.extname(filename).toLowerCase();
    
    // Set appropriate content type
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
      '.zip': 'application/zip'
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';
    
    // Set headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year cache
    
    // Send file
    res.sendFile(filePath);

  } catch (error) {
    console.error('Error serving file:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to serve file',
      code: 'FILE_SERVE_ERROR'
    });
  }
});

/**
 * Delete uploaded file
 */
router.delete('/files/:filename', authenticate, async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(__dirname, '../../uploads', filename);

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch (error) {
      return res.status(404).json({
        success: false,
        message: 'File not found',
        code: 'FILE_NOT_FOUND'
      });
    }

    // Delete file
    await fs.unlink(filePath);

    res.json({
      success: true,
      message: 'File deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete file',
      code: 'FILE_DELETE_ERROR'
    });
  }
});

/**
 * Get upload info/limits
 */
router.get('/info', authenticate, async (req, res) => {
  try {
    const uploadInfo = {
      maxFileSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      allowedTypes: [
        'image/jpeg',
        'image/png', 
        'image/gif',
        'image/webp',
        'image/svg+xml',
        'application/pdf',
        'text/plain',
        'text/markdown',
        'application/json',
        'application/zip'
      ],
      allowedExtensions: [
        '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
        '.pdf', '.txt', '.md', '.json', '.zip'
      ]
    };

    res.json({
      success: true,
      data: uploadInfo
    });

  } catch (error) {
    console.error('Error getting upload info:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get upload info',
      code: 'UPLOAD_INFO_ERROR'
    });
  }
});

// Error handling middleware for multer
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    let message = 'Upload error';
    let code = 'UPLOAD_ERROR';
    
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        message = 'File too large. Maximum size is 10MB';
        code = 'FILE_TOO_LARGE';
        break;
      case 'LIMIT_FILE_COUNT':
        message = 'Too many files. Maximum is 5 files';
        code = 'TOO_MANY_FILES';
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message = 'Unexpected file field';
        code = 'UNEXPECTED_FILE';
        break;
    }
    
    return res.status(400).json({
      success: false,
      message,
      code,
      details: error.message
    });
  }
  
  if (error.message.includes('File type') && error.message.includes('not allowed')) {
    return res.status(400).json({
      success: false,
      message: error.message,
      code: 'INVALID_FILE_TYPE'
    });
  }
  
  next(error);
});

module.exports = router;