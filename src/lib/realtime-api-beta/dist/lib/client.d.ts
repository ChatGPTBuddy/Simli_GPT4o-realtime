export interface ItemType {
  id: string;
  role?: string;
  type?: string;
  status?: string;
  formatted: {
    text?: string;
    transcript?: string;
    audio?: Int16Array;
    tool?: {
      name: string;
      arguments: string;
    };
    output?: string;
    file?: {
      url: string;
    };
  };
}
