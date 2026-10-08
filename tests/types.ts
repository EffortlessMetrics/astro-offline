import offline, {generateOfflineWorker, type OfflineOptions} from '@effortlessmetrics/astro-offline/integration';
import {installOfflineRegistration, backgroundDownloadsAllowed} from '@effortlessmetrics/astro-offline/client';
const policy: OfflineOptions={cachePrefix:'neutral-',globPatterns:['**/*.html'],maxBytes:4096,worker:{navigationStrategy:'network-first',navigationTimeoutMs:1000}};
offline(policy); void generateOfflineWorker('dist',policy);
const dispose=installOfflineRegistration({workerURL:'/sw.js',scope:'/',ownershipGuard:true,reuseExisting:true,requireVisible:true,idle:true}); dispose();
installOfflineRegistration({workerURL:'/sw.js',onLifecycle(state,details){const lifecycle: 'installing'|'installed'|'activating'|'active'|'failed'=state;const active:boolean=details.hasActiveWorker;const controller:boolean=details.controlsPage;const url:string=details.workerURL;const error:Error|undefined=details.error;void [lifecycle,active,controller,url,error];}});
backgroundDownloadsAllowed({saveData:false,effectiveType:'4g'},true);
