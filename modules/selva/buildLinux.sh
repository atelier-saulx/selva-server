docker build -t selva-server-build-linux .
distpath=$(node -e "const p = require('path'); console.log(path.resolve(process.cwd(), '../binaries/linux_x64'))")
docker run -v $distpath:/dist selva-server-build-linux