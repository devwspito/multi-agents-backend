import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function check() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const { Repository } = await import('../src/models/Repository');
  const repos = await Repository.find({});

  console.log(`\n📦 Found ${repos.length} repositories:\n`);

  for (const repo of repos) {
    console.log(`  📁 ${repo.name} (${repo.githubRepoName})`);
    if (repo.envVariables && repo.envVariables.length > 0) {
      console.log(`     Environment Variables: ${repo.envVariables.length}`);
      for (const env of repo.envVariables) {
        const isEncrypted = env.value.startsWith('enc:') ? '🔐 ENCRYPTED' : '⚠️  PLAIN TEXT';
        console.log(`       - ${env.key}: ${isEncrypted} (isSecret: ${env.isSecret})`);
      }
    } else {
      console.log(`     No environment variables`);
    }
    console.log('');
  }

  await mongoose.disconnect();
}

check();
