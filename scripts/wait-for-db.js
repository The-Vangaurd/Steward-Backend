const { PrismaClient } = require('@prisma/client');

async function checkConnection() {
  const maxRetries = 10;
  const delay = 3000; // 3 seconds
  let hasErrors = false;

  if (!process.env.DATABASE_URL) {
    console.error('❌ Error: DATABASE_URL environment variable is missing.');
    hasErrors = true;
  }

  if (!process.env.REDIS_URL) {
    console.error('❌ Error: REDIS_URL environment variable is missing.');
    hasErrors = true;
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error('❌ Error: JWT_SECRET environment variable is missing.');
    hasErrors = true;
  } else if (jwtSecret.length < 32) {
    console.error('❌ Error: JWT_SECRET must be at least 32 characters long.');
    hasErrors = true;
  } else if (jwtSecret === 'your-super-secret-jwt-key-minimum-32-characters') {
    console.error('❌ Error: JWT_SECRET is using the placeholder value. Please set a real secret.');
    hasErrors = true;
  }

  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;
  if (!jwtRefreshSecret) {
    console.error('❌ Error: JWT_REFRESH_SECRET environment variable is missing.');
    hasErrors = true;
  } else if (jwtRefreshSecret.length < 32) {
    console.error('❌ Error: JWT_REFRESH_SECRET must be at least 32 characters long.');
    hasErrors = true;
  } else if (jwtRefreshSecret === 'your-super-secret-refresh-key-minimum-32-characters') {
    console.error('❌ Error: JWT_REFRESH_SECRET is using the placeholder value. Please set a real secret.');
    hasErrors = true;
  }

  if (hasErrors) {
    console.error('\n👉 Please configure all required environment variables in your Render/Vercel dashboard.');
    process.exit(1);
  }

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  });
  
  console.log('🔄 Checking database connectivity...');
  for (let i = 1; i <= maxRetries; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log('✅ Database is ready and reachable!');
      await prisma.$disconnect();
      process.exit(0);
    } catch (error) {
      console.log(`⚠️ Connection attempt ${i}/${maxRetries} failed. Retrying in ${delay / 1000}s...`);
      if (i === maxRetries) {
        console.error('❌ Error: Could not connect to the database after all attempts.');
        console.error(error.message);
        await prisma.$disconnect();
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

checkConnection();

