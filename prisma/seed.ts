import { PrismaClient, UserRole, KitchenType } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // ── Restaurant ────────────────────────────────────────────────────────────────
  const restaurant = await prisma.restaurant.upsert({
    where: { slug: 'spice-garden' },
    update: {},
    create: {
      name: 'Spice Garden',
      slug: 'spice-garden',
      restaurantCode: 'SPICEG',
      description: 'Authentic Indian cuisine with a modern twist',
      phone: '+91 98765 43210',
      email: 'hello@spicegarden.com',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      address: {
        street: '42, MG Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        zip: '560001',
      },
    },
  });

  console.log(`✅ Restaurant: ${restaurant.name} (${restaurant.id})`);

  // ── Admin user ────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash('Admin@1234', 12);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@spicegarden.com' },
    update: {
      emailVerified: true,
      isActive: true,
    },
    create: {
      email: 'admin@spicegarden.com',
      passwordHash: hash,
      firstName: 'Ravi',
      lastName: 'Kumar',
      role: UserRole.ADMIN,
      restaurantId: restaurant.id,
      emailVerified: true,
      isActive: true,
    },
  });

  const kitchenUser = await prisma.user.upsert({
    where: { email: 'kitchen@spicegarden.com' },
    update: {
      emailVerified: true,
      isActive: true,
    },
    create: {
      email: 'kitchen@spicegarden.com',
      passwordHash: await bcrypt.hash('Kitchen@1234', 12),
      firstName: 'Arjun',
      lastName: 'Chef',
      role: UserRole.KITCHEN_STAFF,
      restaurantId: restaurant.id,
      emailVerified: true,
      isActive: true,
    },
  });

  console.log(`✅ Admin: ${admin.email}`);
  console.log(`✅ Kitchen staff: ${kitchenUser.email}`);

  // ── Categories ────────────────────────────────────────────────────────────────
  const categories = await Promise.all([
    prisma.category.upsert({
      where: { id: 'cat-starters' },
      update: {},
      create: { id: 'cat-starters', restaurantId: restaurant.id, name: 'Starters', sortOrder: 1 },
    }),
    prisma.category.upsert({
      where: { id: 'cat-mains' },
      update: {},
      create: { id: 'cat-mains', restaurantId: restaurant.id, name: 'Main Course', sortOrder: 2 },
    }),
    prisma.category.upsert({
      where: { id: 'cat-breads' },
      update: {},
      create: { id: 'cat-breads', restaurantId: restaurant.id, name: 'Breads', sortOrder: 3 },
    }),
    prisma.category.upsert({
      where: { id: 'cat-beverages' },
      update: {},
      create: { id: 'cat-beverages', restaurantId: restaurant.id, name: 'Beverages', sortOrder: 4 },
    }),
  ]);

  console.log(`✅ ${categories.length} categories created`);

  // ── Menu items ────────────────────────────────────────────────────────────────
  const menuItems = [
    { categoryId: 'cat-starters', name: 'Paneer Tikka', price: 280, kitchenType: KitchenType.TIME_TAKING, prepTimeMins: 20, isPopular: true },
    { categoryId: 'cat-starters', name: 'Veg Spring Rolls', price: 180, kitchenType: KitchenType.READY_TO_SERVE, prepTimeMins: 10 },
    { categoryId: 'cat-starters', name: 'Chicken 65', price: 320, kitchenType: KitchenType.TIME_TAKING, prepTimeMins: 25, isPopular: true },
    { categoryId: 'cat-mains', name: 'Dal Makhani', price: 240, kitchenType: KitchenType.MAIN, prepTimeMins: 15 },
    { categoryId: 'cat-mains', name: 'Butter Chicken', price: 380, kitchenType: KitchenType.MAIN, prepTimeMins: 20, isPopular: true },
    { categoryId: 'cat-mains', name: 'Palak Paneer', price: 280, kitchenType: KitchenType.MAIN, prepTimeMins: 15 },
    { categoryId: 'cat-mains', name: 'Biryani (Veg)', price: 320, kitchenType: KitchenType.TIME_TAKING, prepTimeMins: 30 },
    { categoryId: 'cat-mains', name: 'Biryani (Chicken)', price: 380, kitchenType: KitchenType.TIME_TAKING, prepTimeMins: 30, isPopular: true },
    { categoryId: 'cat-breads', name: 'Butter Naan', price: 50, kitchenType: KitchenType.READY_TO_SERVE, prepTimeMins: 8 },
    { categoryId: 'cat-breads', name: 'Garlic Naan', price: 70, kitchenType: KitchenType.READY_TO_SERVE, prepTimeMins: 8 },
    { categoryId: 'cat-breads', name: 'Paratha', price: 60, kitchenType: KitchenType.READY_TO_SERVE, prepTimeMins: 8 },
    { categoryId: 'cat-beverages', name: 'Mango Lassi', price: 120, kitchenType: KitchenType.READY_TO_SERVE, prepTimeMins: 5 },
    { categoryId: 'cat-beverages', name: 'Masala Chai', price: 60, kitchenType: KitchenType.READY_TO_SERVE, prepTimeMins: 5 },
    { categoryId: 'cat-beverages', name: 'Fresh Lime Soda', price: 80, kitchenType: KitchenType.READY_TO_SERVE, prepTimeMins: 3 },
  ];

  let created = 0;
  for (const item of menuItems) {
    const existing = await prisma.menuItem.findFirst({
      where: { name: item.name, categoryId: item.categoryId },
    });
    if (!existing) {
      await prisma.menuItem.create({ data: item });
      created++;
    }
  }

  console.log(`✅ ${created} menu items created (${menuItems.length - created} already existed)`);
  console.log('\n🎉 Seed complete!');
  console.log(`\n📋 Credentials:`);
  console.log(`   Admin:   admin@spicegarden.com  / Admin@1234`);
  console.log(`   Kitchen: kitchen@spicegarden.com / Kitchen@1234`);
  console.log(`\n🏪 Restaurant ID: ${restaurant.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
