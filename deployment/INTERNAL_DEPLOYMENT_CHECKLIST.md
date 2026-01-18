# Deployment Interno - Checklist para Nuevo Cliente

## Datos que necesitamos del cliente

- [ ] Email de Google (para crear cuenta GCP)
- [ ] Contraseña temporal o acceso delegado
- [ ] Nombre de la empresa (para naming)
- [ ] Dominio (si tienen, para SSL)

---

## PASO 1: Google Cloud (~10 min)

### 1.1 Crear proyecto GCP
```bash
# Login con cuenta del cliente
gcloud auth login

# Variables
CLIENT_NAME="acme"  # Cambiar por nombre del cliente
PROJECT_ID="${CLIENT_NAME}-agents"
REGION="us-central1"
ZONE="${REGION}-a"

# Crear proyecto
gcloud projects create $PROJECT_ID --name="Multi-Agent Platform - ${CLIENT_NAME}"
gcloud config set project $PROJECT_ID

# Habilitar billing (requiere cuenta de facturación)
# El cliente debe tener billing configurado
```

### 1.2 Crear VM + Disco
```bash
# Crear Persistent Disk (SSD 100GB)
gcloud compute disks create ${CLIENT_NAME}-data \
  --size=100GB \
  --type=pd-ssd \
  --zone=$ZONE

# Crear VM
gcloud compute instances create ${CLIENT_NAME}-agents \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB \
  --disk=name=${CLIENT_NAME}-data,device-name=data-disk,mode=rw,boot=no \
  --zone=$ZONE \
  --tags=http-server,https-server

# Firewall rules
gcloud compute firewall-rules create allow-agents-api \
  --allow=tcp:3001,tcp:443 \
  --target-tags=http-server
```

### 1.3 Configurar snapshots automáticos
```bash
gcloud compute resource-policies create snapshot-schedule ${CLIENT_NAME}-backup \
  --region=$REGION \
  --max-retention-days=7 \
  --daily-schedule \
  --start-time=02:00

gcloud compute disks add-resource-policies ${CLIENT_NAME}-data \
  --resource-policies=${CLIENT_NAME}-backup \
  --zone=$ZONE
```

**Anotar:**
- [ ] IP externa del VM: _______________
- [ ] Project ID: _______________

---

## PASO 2: MongoDB Atlas (~5 min)

### 2.1 Crear cuenta/organización
1. Ir a [cloud.mongodb.com](https://cloud.mongodb.com)
2. Crear cuenta con email del cliente
3. Crear organización: `${CLIENT_NAME}-org`

### 2.2 Crear cluster
1. Create Cluster → Dedicated (M10 mínimo)
2. Cloud Provider: Google Cloud
3. Region: **us-central1** (misma que VM)
4. Cluster Name: `agents-cluster`

### 2.3 Configurar acceso
1. Database Access → Add User
   - Username: `agents-admin`
   - Password: **Generar y guardar**
   - Role: `readWriteAnyDatabase`

2. Network Access → Add IP
   - IP del VM: `{IP_EXTERNA_VM}`
   - O `0.0.0.0/0` temporalmente

3. Connect → Connect your application
   - Copiar connection string

**Anotar:**
- [ ] MongoDB URI: `mongodb+srv://agents-admin:PASSWORD@agents-cluster.xxx.mongodb.net/agents-prod`

---

## PASO 3: GitHub OAuth App (~3 min)

1. Ir a [github.com/settings/developers](https://github.com/settings/developers)
2. OAuth Apps → New OAuth App
3. Configurar:
   - Name: `Multi-Agent Platform - ${CLIENT_NAME}`
   - Homepage: `http://{IP_EXTERNA_VM}:3001`
   - Callback: `http://{IP_EXTERNA_VM}:3001/api/auth/github/callback`

**Anotar:**
- [ ] Client ID: _______________
- [ ] Client Secret: _______________

---

## PASO 4: Setup del VM (~5 min)

### 4.1 SSH al VM
```bash
gcloud compute ssh ${CLIENT_NAME}-agents --zone=$ZONE
```

### 4.2 Ejecutar setup
```bash
# Instalar Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Montar disco
sudo mkfs.ext4 -m 0 -F -E lazy_itable_init=0,discard /dev/sdb
sudo mkdir -p /mnt/data
sudo mount -o discard,defaults /dev/sdb /mnt/data
echo "/dev/sdb /mnt/data ext4 discard,defaults,nofail 0 2" | sudo tee -a /etc/fstab
sudo mkdir -p /mnt/data/{agent-workspace,mongodb-data}
sudo chown -R $USER:$USER /mnt/data

# Crear directorio de app
mkdir -p /app && cd /app
```

### 4.3 Crear archivos de configuración
```bash
# Descargar docker-compose
curl -O https://raw.githubusercontent.com/<org>/agents-backend/main/docker-compose.prod.yml

# Crear .env (copiar y pegar valores)
cat > .env << 'ENV'
# MongoDB Atlas
MONGODB_URI=mongodb+srv://agents-admin:PASSWORD@cluster.xxx.mongodb.net/agents-prod

# Anthropic (nuestra key o la del cliente)
ANTHROPIC_API_KEY=sk-ant-xxx

# GitHub OAuth
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx

# Security
JWT_SECRET=GENERAR_CON_openssl_rand_-base64_32

# URLs
BASE_URL=http://IP_VM:3001
FRONTEND_URL=http://IP_VM:3000
PORT=3001
ENV
```

### 4.4 Iniciar servicios
```bash
docker compose up -d
```

### 4.5 Verificar
```bash
# Health check
curl http://localhost:3001/api/health

# Ver logs
docker logs -f agents-backend
```

---

## PASO 5: Verificación Final

- [ ] `curl http://{IP}:3001/api/health` retorna `{"status":"ok"}`
- [ ] Login con GitHub funciona
- [ ] Crear tarea de prueba funciona
- [ ] Agentes ejecutan correctamente

---

## PASO 6: Entregar al Cliente

### Información a entregar:
```
URL de la plataforma: http://{IP}:3001
Frontend: http://{IP}:3000 (si aplica)

Accesos creados:
- Google Cloud Console: console.cloud.google.com
- MongoDB Atlas: cloud.mongodb.com
- Project ID: ${CLIENT_NAME}-agents

Soporte: soporte@tuempresa.com
```

### Documentación a entregar:
- Guía de uso básico
- Cómo ver logs
- Cómo contactar soporte

---

## Comandos útiles post-deployment

```bash
# SSH al VM
gcloud compute ssh ${CLIENT_NAME}-agents --zone=us-central1-a

# Ver logs
docker logs -f agents-backend

# Reiniciar
docker compose restart

# Actualizar a nueva versión
docker compose pull && docker compose up -d

# Backup manual
gcloud compute disks snapshot ${CLIENT_NAME}-data --snapshot-names="manual-$(date +%Y%m%d)"
```
