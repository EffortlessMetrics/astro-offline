import offline, {generateOfflineWorker, type OfflineOptions} from '@effortlessmetrics/astro-offline/integration';
import {installOfflineRegistration, backgroundDownloadsAllowed} from '@effortlessmetrics/astro-offline/client';
const policy: OfflineOptions={cachePrefix:'neutral-',globPatterns:['**/*.html'],maxBytes:4096,worker:{navigationStrategy:'network-first',navigationTimeoutMs:1000}};
offline(policy); void generateOfflineWorker('dist',policy);
const dispose=installOfflineRegistration({workerURL:'/sw.js',scope:'/',ownershipGuard:true,reuseExisting:true,requireVisible:true,idle:true}); dispose();
backgroundDownloadsAllowed({saveData:false,effectiveType:'4g'},true);
