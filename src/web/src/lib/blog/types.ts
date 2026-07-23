export type BlogPost = {
  slug: string;
  title: string;
  date: string;
  /** ISO date (YYYY-MM-DD) when the published post was last revised. */
  dateModified?: string;
  author: string;
  excerpt: string;
  readingTime: string;
  image?: string;
  draft?: boolean;
};
