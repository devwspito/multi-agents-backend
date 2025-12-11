import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function verify() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const { Repository } = await import('../src/models/Repository');
  const { EnvService } = await import('../src/services/EnvService');

  // Get all repos with envVariables
  const repos = await Repository.find({
    'envVariables.0': { $exists: true }
  });

  if (repos.length === 0) {
    console.log('❌ No repositories with environment variables found');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n🔐 Verifying decryption for ${repos.length} repositories...\n`);
  console.log('=' .repeat(50));

  let totalSuccess = 0;
  let totalFail = 0;

  for (const repo of repos) {
    let secrets = 0;
    let decrypted = 0;
    const failures: string[] = [];

    for (const envVar of repo.envVariables) {
      if (envVar.isSecret) {
        secrets++;
        try {
          EnvService.decryptValue(envVar.value);
          decrypted++;
          totalSuccess++;
        } catch (e: any) {
          failures.push(`${envVar.key}: ${e.message}`);
          totalFail++;
        }
      }
    }

    if (secrets > 0) {
      const status = decrypted === secrets ? '✅' : '❌';
      console.log(`${status} ${repo.name}: ${decrypted}/${secrets} secrets OK`);
      failures.forEach(f => console.log(`   ❌ ${f}`));
    }
  }

  console.log('=' .repeat(50));
  console.log(`\n📊 TOTAL: ${totalSuccess} decrypted successfully, ${totalFail} failed`);

  if (totalFail === 0) {
    console.log('\n✅ All secrets decrypt correctly! Orchestrator will work perfectly.\n');
  } else {
    console.log('\n⚠️  Some secrets failed to decrypt. Check encryption key consistency.\n');
  }

  await mongoose.disconnect();
}

verify().catch(console.error);
