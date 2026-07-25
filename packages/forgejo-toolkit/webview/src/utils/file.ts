const IMAGE_TYPE_PATTERN = /^image\//;
const IMAGE_EXTENSION_PATTERN = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i;

export function isImageFile(file: File): boolean {
  if (IMAGE_TYPE_PATTERN.test(file.type)) {
    return true;
  }
  return IMAGE_EXTENSION_PATTERN.test(file.name);
}
