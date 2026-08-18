import { postShopGridImage } from "./postGridImage.js";

postShopGridImage().catch((err) => {
  console.error(err);
  process.exit(1);
});
