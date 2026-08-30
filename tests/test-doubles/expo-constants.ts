export enum ExecutionEnvironment {
  Bare = "bare",
  StoreClient = "store",
}

const Constants = {
  executionEnvironment: ExecutionEnvironment.Bare,
  expoConfig: {
    ios: {
      associatedDomains: ["applinks:api.cartiva.test"],
    },
  },
};

export default Constants;
