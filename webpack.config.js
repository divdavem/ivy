const path = require("path");

module.exports = [{
    name: 'mocha',
    mode: 'development',
    target: 'node',
    entry: {
        "mocha.specs": "./src/test/runtime/testapp.ts"
    },
    // devtool: "inline-source-map",
    module: {
        rules: [
            {
                test: /\.ts$/,
                loader: "ts-loader",
                exclude: /node_modules/,
                options: {
                    configFile: "tsconfig.webpack.json"
                }
            },
            {
                test: /\.(ts|js)$/,
                loader: "./dist/webpack/loader.js"
            }
        ]
    },
    resolve: {
        extensions: [".ts", ".js"]
    },
    output: {
        filename: "[name].js",
        path: path.resolve(__dirname, "dist")
    }
}, {
    name: 'samples',
    mode: 'none',
    target: 'web',
    entry: {
        "hello": "./src/samples/hello/hello.ts",
        "greetings": "./src/samples/greetings/greetings.ts",
        "triangles": "./src/samples/triangles/triangles.ts",
        "flex": "./src/samples/flex/flex.ts"
    },
    module: {
        rules: [{
            test: /\.ts$/,
            loader: "ts-loader",
            exclude: /node_modules/,
            options: {
                configFile: "tsconfig.webpack.json"
            }
        }, {
            test: /\.(ts|js)$/,
            loader: "./dist/webpack/loader.js"
        }, {
            test: /\.(html|css|svg|data)$/,
            use: [{
                loader: 'file-loader',
                options: {
                    name: 'samples/[folder]/[name].[ext]',
                }
            }]
        }]
    },
    resolve: {
        extensions: [".ts", ".js"]
    },
    output: {
        filename: "samples/[name]/[name].js",
        path: path.resolve(__dirname, "dist")
    }
}];