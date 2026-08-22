import type { UploadApiResponse } from "cloudinary";
import { cloudinaryUpload } from "../../lib/cloudinary";
import { prisma } from "../../lib/prisma";
import { tr } from "zod/locales";

const uploadProfileImageIntoDb = async (buffer: Buffer, userId: string) => {
  // const cloudinaryResult = cloudinaryUpload.uploader
  //   .upload_stream(
  //     {
  //       resource_type: "auto",
  //     },
  //     async (error, result) => {
  //       if (error) {
  //         console.log(error);
  //         throw new Error(error.message);
  //       }

  //       const updatedUser = await prisma.user.update({
  //         where: { id: userId },
  //         data: {
  //           imageUrl: result?.secure_url,
  //           imagePublicId: result?.public_id,
  //         },
  //       });
  //       console.log(updatedUser, "from updated user");
  //       // return result;
  //     },
  //   )
  //   .end(buffer);

  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      imagePublicId: true,
      imageUrl: true,
    },
  });

  const cloudinaryResult = await new Promise<UploadApiResponse>(
    (resolve, reject) => {
      cloudinaryUpload.uploader
        .upload_stream(
          {
            resource_type: "auto",
          },
          async (error, result) => {
            if (error) {
              return reject(error);
            }
            if (!result) {
              return reject(new Error("Something went wrong!"));
            }
            resolve(result);
            // return result;
          },
        )
        .end(buffer);
    },
  );
  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      imageUrl: cloudinaryResult?.secure_url,
      imagePublicId: cloudinaryResult?.public_id,
    },
    omit: {
      password: true,
    },
  });

  if (currentUser?.imagePublicId && currentUser.imageUrl) {
    await cloudinaryUpload.uploader.destroy(currentUser.imagePublicId);
  }

  return updatedUser;
};

export const userServices = {
  uploadProfileImageIntoDb,
};
