#!/bin/bash
# AI Development Team CLI Installer
# Developers run this to install the CLI on their machine

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║                                                       ║"
echo "  ║       🤖 AI Development Team - CLI Installer          ║"
echo "  ║                                                       ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is required but not installed.${NC}"
    echo ""
    echo "   Install Node.js 18+ from: https://nodejs.org/"
    echo "   Or use a version manager like nvm:"
    echo "   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
    exit 1
fi

# Check Node version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ Node.js 18+ is required. You have: $(node -v)${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Node.js $(node -v) detected${NC}"

# Install the CLI globally
echo ""
echo -e "${YELLOW}Installing AI Dev Team CLI...${NC}"

# Option 1: From npm (when published)
# npm install -g @aidevteam/cli

# Option 2: From tarball (for now)
INSTALL_DIR="$HOME/.aidevteam"
mkdir -p "$INSTALL_DIR"

# Download latest release
echo "Downloading CLI package..."
# curl -L https://releases.aidevteam.com/cli/latest.tar.gz -o /tmp/aidev-cli.tar.gz
# tar -xzf /tmp/aidev-cli.tar.gz -C "$INSTALL_DIR"

# For development: copy from local
if [ -d "./cli" ]; then
    cp -r ./cli/* "$INSTALL_DIR/"
fi

# Install dependencies
cd "$INSTALL_DIR"
npm install --production 2>/dev/null || npm install

# Build if needed
if [ -f "package.json" ] && grep -q '"build"' package.json; then
    npm run build 2>/dev/null || true
fi

# Create symlink
LINK_PATH="/usr/local/bin/aidev"
if [ -w "/usr/local/bin" ]; then
    ln -sf "$INSTALL_DIR/dist/index.js" "$LINK_PATH" 2>/dev/null || true
    chmod +x "$LINK_PATH" 2>/dev/null || true
else
    # Try user's local bin
    mkdir -p "$HOME/.local/bin"
    ln -sf "$INSTALL_DIR/dist/index.js" "$HOME/.local/bin/aidev" 2>/dev/null || true
    chmod +x "$HOME/.local/bin/aidev" 2>/dev/null || true

    # Add to PATH if needed
    if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc" 2>/dev/null || true
        echo -e "${YELLOW}Note: Added ~/.local/bin to your PATH. Restart your terminal or run:${NC}"
        echo '  export PATH="$HOME/.local/bin:$PATH"'
    fi
fi

echo ""
echo -e "${GREEN}✅ Installation complete!${NC}"
echo ""
echo -e "${CYAN}Quick Start:${NC}"
echo ""
echo "  1. Connect to your company server:"
echo -e "     ${YELLOW}aidev connect https://yourcompany.aidevteam.com${NC}"
echo ""
echo "  2. Start the interactive CLI:"
echo -e "     ${YELLOW}aidev${NC}"
echo ""
echo "  3. Check connection status:"
echo -e "     ${YELLOW}aidev status${NC}"
echo ""
echo -e "${CYAN}Need help?${NC}"
echo "  aidev --help"
echo ""
