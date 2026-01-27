# Multi-Agent Platform - VM Deployment Guide

## Quick Deploy (No Docker)

### Full Stack Update (Backend + Frontend)

Single command to update both services:

```bash
cd ~/agents-software-arq && git pull && npm run build && cd ~/mult-agents-frontend && git pull && npm run build && sudo cp -r dist/* /var/www/html/
```

### Individual Services

#### Backend Only

```bash
cd ~/agents-software-arq && git pull && npm run build
```

#### Frontend Only

```bash
cd ~/mult-agents-frontend && git pull && npm run build && sudo cp -r dist/* /var/www/html/
```

## Directory Structure

| Service  | Path                     | Served By     |
|----------|--------------------------|---------------|
| Backend  | `~/agents-software-arq`  | PM2 (Node.js) |
| Frontend | `~/mult-agents-frontend` | Nginx         |
| Static   | `/var/www/html/`         | Nginx         |

## Troubleshooting

### Backend not responding

```bash
pm2 logs agents-backend --lines 100
pm2 restart agents-backend
```

### Frontend not updating

```bash
# Verify build completed
ls -la /mult-agents-frontend/dist/

# Check nginx status
sudo systemctl status nginx

# Reload nginx if needed
sudo systemctl reload nginx
```

### Permission issues

```bash
# Fix frontend static files permissions
sudo chown -R www-data:www-data /var/www/html/
```
