import z, { email } from "zod";

const PatientRegistrationZodSchema = z.object({
  name: z.string().min(3, "Name must be atleast 3 characters long!").max(10),
  email: z.email("Not a valid email"),
  password: z
    .string()
    .min(8, "Password must be atleast 8 character long")
    .regex(/[A-Z]/, "Password must contain atleast 1 uppercase character")
    .regex(/[a-z]/, "Password must contain atleast 1 lowercase character")
    .regex(/[0-9]/, "Password must contain atleast 1 numberr")
    .regex(/[^A-Za-z0-9]/, "Password must contain atleast 1 special character"),
  patient: z
    .object({
      contactNumber: z.string().optional(),
    })
    .optional(),
});
const PatientEmailVerifyZodSchema = z.object({
  email: z.email("Not a valid email"),
  otp: z.string().length(6),
});

const ForgotPasswordZodSchema = z.object({
  email: z.email(),
});

const ResetPasswordZodSchema = z.object({
  email: z.email("Not a valid email"),
  newPassword: z
    .string()
    .min(8, "Password must be atleast 8 character long")
    .regex(/[A-Z]/, "Password must contain atleast 1 uppercase character")
    .regex(/[a-z]/, "Password must contain atleast 1 lowercase character")
    .regex(/[0-9]/, "Password must contain atleast 1 numberr")
    .regex(/[^A-Za-z0-9]/, "Password must contain atleast 1 special character"),
  otp: z.string().length(6),
});

const loginZodSchema = z.object({
  email: z.email(),
  password: z.string(),
});

export const UserValidation = {
  PatientRegistrationZodSchema,
  PatientEmailVerifyZodSchema,
  loginZodSchema,
  ForgotPasswordZodSchema,
  ResetPasswordZodSchema,
};
