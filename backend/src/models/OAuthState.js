const mongoose = require('mongoose');

/**
 * OAuth State Model
 * Temporary storage for OAuth state parameters
 */
const oAuthStateSchema = new mongoose.Schema({
  state: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 600 // TTL: Auto-delete after 10 minutes (600 seconds)
  }
});

module.exports = mongoose.model('OAuthState', oAuthStateSchema);
