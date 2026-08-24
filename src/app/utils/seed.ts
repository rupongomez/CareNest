import bcrypt from "bcryptjs";
import { Role } from "../../generated/prisma/enums";
import { prisma } from "../lib/prisma";
import config from "../config";

export const seedSuperAdmin = async () => {
  try {
    const isSuperAdminExist = await prisma.user.findFirst({
      where: {
        role: Role.SUPER_ADMIN,
      },
    });
    if (isSuperAdminExist) {
      console.log("Super admin exist");
      return;
    }
    const name = config.super_admin_name;
    const email = config.super_admin_name;
    const password = config.super_admin_password;

    if (!name || !email || !password) {
      throw new Error("Super admin credentials missing in env");
    }

    const hashedPassword = await bcrypt.hash(
      password,
      Number(config.bcrypt_salt_rounds),
    );

    const superAdmin = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: Role.SUPER_ADMIN,
        needPasswordChange: false,
        emailVerified: true,
      },
    });

    console.log("Super admin created : ", superAdmin);
  } catch (error) {
    console.log("Error seeding SuperAdmin", error);
    await prisma.user.delete({
      where: {
        email: config.super_admin_email,
      },
    });
  }
};

export const seedTesterAdmin = async () => {
  try {
    const isTesterAdminExist = await prisma.user.findUnique({
      where: {
        role: Role.ADMIN,
        email: config.tester_admin_email,
      },
    });

    if (isTesterAdminExist) {
      console.log("Tester admin exist");
      return;
    }

    const name = config.tester_admin_name;
    const email = config.tester_admin_email;
    const password = config.tester_admin_password;

    if (!name || !email || !password) {
      throw new Error("Tester admin credentials missing in env");
    }

    const hashedPassword = await bcrypt.hash(
      password,
      Number(config.bcrypt_salt_rounds),
    );

    const testerAdmin = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: Role.ADMIN,
        needPasswordChange: false,
        emailVerified: true,
      },
    });

    console.log("Tester admin created: ", testerAdmin);
  } catch (error) {
    console.log("Error seeding Tester Admin", error);

    if (config.tester_admin_email) {
      await prisma.user.delete({
        where: {
          email: config.tester_admin_email,
        },
      });
    }
  }
};

export const seedTesterDoctor = async () => {
  try {
    const isTesterDoctorExist = await prisma.user.findUnique({
      where: {
        role: Role.DOCTOR,
        email: config.tester_doctor_email,
      },
    });

    if (isTesterDoctorExist) {
      console.log("Tester doctor exist");
      return;
    }

    const name = config.tester_doctor_name;
    const email = config.tester_doctor_email;
    const password = config.tester_doctor_password;

    if (!name || !email || !password) {
      throw new Error("Tester doctor credentials missing in env");
    }

    const hashedPassword = await bcrypt.hash(
      password,
      Number(config.bcrypt_salt_rounds),
    );

    const testerDoctor = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: Role.DOCTOR,
        needPasswordChange: false,
        emailVerified: true,
        doctor: {
          create: {
            email,
            name,
            experienceYears: 5,
            licenseNumber: "BMDC000",
            qualifications: "MBBS",
            specialization: "Neurology",
          },
        },
      },
    });

    console.log("Tester doctor created: ", testerDoctor);
  } catch (error) {
    console.log("Error seeding Tester Doctor", error);

    if (config.tester_doctor_email) {
      await prisma.user.delete({
        where: {
          email: config.tester_doctor_email,
        },
      });
    }
  }
};
