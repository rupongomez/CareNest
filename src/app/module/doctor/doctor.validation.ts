import { z } from "zod";

export const applyAsDoctorValidationZodSchema = z.object({
  user: z.object({
    name: z.string().min(2, "Name must be at least 2 characters"),

    email: z.email("Invalid email address"),
  }),

  doctor: z.object({
    specialization: z.string().min(2, "Specialization is required"),

    licenseNumber: z.string().min(3, "License number is required"),

    qualifications: z.string().min(2, "Qualifications are required"),

    experienceYears: z.coerce
      .number()
      .int("Experience must be a whole number")
      .min(0, "Experience cannot be negative"),

    bio: z.string().max(1000, "Bio cannot exceed 1000 characters").optional(),

    consultationFee: z
      .number()
      .min(0, "Consultation fee cannot be negative")
      .optional(),

    contactNumber: z.string().min(10, "Invalid contact number").optional(),
  }),
});

export const UpdateDoctorProfileValidationZodSchema = z.object({
  address: z
    .string()
    .trim()
    .min(5, "Address must be at least 5 characters long")
    .optional(),

  bio: z
    .string()
    .trim()
    .max(1000, "Bio cannot exceed 1000 characters")
    .optional(),

  consultationFee: z
    .number()
    .min(0, "Consultation fee cannot be negative")
    .optional(),

  contactNumber: z
    .string()
    .trim()
    .min(5, "Contact number is invalid")
    .optional(),
});
