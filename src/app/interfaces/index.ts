export interface IQuery {
  searchTerm?: string;
  page?: string;
  limit?: string;
  sortOrder?: string;
  sortBy?: string;

  //   any other filter fields can be added here as optional properties
  [key: string]: any;
}
