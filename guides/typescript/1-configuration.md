# Configuration

There are currently two ways to gain access to EmberData's native types.
Follow the configuration guide below for the [installation](./0-installation.md)
option you chose.

1) [Use Canary](#using-canary)

2) [Use Official Types Packages](#using-types-packages)
with releases `>= 4.12.*`

> [!IMPORTANT]
> EmberData's Native Types require the use of Ember's
> Native Types, the configuration below will also setup
> Your application to consume Ember's Native Types.

### Using Canary

To consume `alpha` stage types, you must import the types in your project's `tsconfig.json`.

For alpha stage types, we add `unstable-preview-types` to the path to help you remember the
potential volatility.

```diff
 {
   "compilerOptions": {
+   "types": [
+      "ember-source/types",
+      "./node_modules/ember-data/unstable-preview-types",
+      "./node_modules/@ember-data/store/unstable-preview-types",
+      "./node_modules/@ember-data/adapter/unstable-preview-types",
+      "./node_modules/@ember-data/graph/unstable-preview-types",
+      "./node_modules/@ember-data/json-api/unstable-preview-types",
+      "./node_modules/@ember-data/legacy-compat/unstable-preview-types",
+      "./node_modules/@ember-data/request/unstable-preview-types",
+      "./node_modules/@ember-data/request-utils/unstable-preview-types",
+      "./node_modules/@ember-data/model/unstable-preview-types",
+      "./node_modules/@ember-data/serializer/unstable-preview-types",
+      "./node_modules/@ember-data/tracking/unstable-preview-types",
+      "./node_modules/@warp-drive/core-types/unstable-preview-types"
+    ]
   }
 }
```

### Using Types Packages

To consume `alpha` stage types, you must import the types in your project's `tsconfig.json`.

For alpha stage types, we add `unstable-preview-types` to the path to help you remember the
potential volatility.

```diff
 {
   "compilerOptions": {
+   "types": [
+      "ember-source/types",
+      "ember-data-types/unstable-preview-types",
+      "@ember-data-types/store/unstable-preview-types",
+      "@ember-data-types/adapter/unstable-preview-types",
+      "@ember-data-types/graph/unstable-preview-types",
+      "@ember-data-types/json-api/unstable-preview-types",
+      "@ember-data-types/legacy-compat/unstable-preview-types",
+      "@ember-data-types/request/unstable-preview-types",
+      "@ember-data-types/request-utils/unstable-preview-types",
+      "@ember-data-types/model/unstable-preview-types",
+      "@ember-data-types/serializer/unstable-preview-types",
+      "@ember-data-types/tracking/unstable-preview-types",
+      "@warp-drive-types/core-types/unstable-preview-types"
+    ]
   }
 }
```
