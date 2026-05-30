import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Fetching users from DB...');
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      isActive: true,
      emailVerified: true,
      restaurantId: true,
    }
  });

  console.log('--- DB Users ---');
  console.log(JSON.stringify(users, null, 2));
  console.log('----------------');
}

main()
  .catch((err) => {
    console.error('Error running script:', err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
